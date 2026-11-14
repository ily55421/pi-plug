package main

// fastsh：常驻 POSIX shell 守护进程（内嵌 mvdan.cc/sh v3）
// 协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应。
// 设计目标：把轻量命令的单次开销从 pwsh 的 ~270ms 降到 ~2ms。
import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"mvdan.cc/sh/v3/interp"
	"mvdan.cc/sh/v3/syntax"
)

// Request 是插件侧发来的单条命令请求
type Request struct {
	ID        int               `json:"id"`
	Command   string            `json:"command"`
	Cwd       string            `json:"cwd"`
	TimeoutMs int               `json:"timeoutMs"`
	Env       map[string]string `json:"env"`
	Shutdown  bool              `json:"shutdown"`
}

// Response 是执行结果；Fallback=true 表示这条命令不该走 sh，应回退到 pwsh
type Response struct {
	ID         int    `json:"id"`
	OK         bool   `json:"ok"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	Fallback   bool   `json:"fallback"`
	Reason     string `json:"reason"`
}

const (
	maxOutputBytes = 8 << 20  // 单次输出上限 8MB，防 OOM
	defaultTimeout = 60 * 1000 // 默认 60s
)

func main() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 32<<20)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			writeResp(out, Response{OK: false, Stderr: "fastsh: 请求 JSON 解析失败: " + err.Error(), ExitCode: 2})
			continue
		}
		if req.Shutdown {
			writeResp(out, Response{ID: req.ID, OK: true})
			out.Flush()
			return
		}
		writeResp(out, safeHandle(req))
		out.Flush()
	}
}

// safeHandle 兜住 handle 的 panic：单条命令的意外崩溃不能带走整个常驻进程，
// 否则后续所有请求都会因为守护进程消失而被迫回退。
func safeHandle(req Request) (resp Response) {
	defer func() {
		if r := recover(); r != nil {
			resp = Response{
				ID:       req.ID,
				OK:       false,
				Fallback: true,
				Reason:   "daemon_panic",
				Stderr:   fmt.Sprintf("fastsh: 守护进程内部错误: %v", r),
				ExitCode: 1,
			}
		}
	}()
	return handle(req)
}

func writeResp(w *bufio.Writer, r Response) {
	b, err := json.Marshal(r)
	if err != nil {
		return
	}
	w.Write(b)
	w.WriteByte('\n')
}

// handle 执行一条命令：先做回退判定，再解析执行
func handle(req Request) Response {
	start := time.Now()
	resp := Response{ID: req.ID}

	// 1) 回退判定：PowerShell 专有语法直接不执行，交给内置 Bash
	if bad, reason := looksLikePowerShell(req.Command); bad {
		resp.OK = false
		resp.Fallback = true
		resp.Reason = reason
		resp.ExitCode = 2
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	// 2) 解析 POSIX 语法
	prog, err := syntax.NewParser().Parse(strings.NewReader(req.Command), "")
	if err != nil {
		resp.OK = false
		resp.Fallback = true
		resp.Reason = "posix_parse_error"
		resp.ExitCode = 2
		resp.Stderr = "fastsh: POSIX 解析失败（可能是 PowerShell 语法）: " + err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	// 3) 首命令可用性检查：不在内置/coreutils/PATH 中则回退
	if name, ok := firstCommandName(prog); ok && !commandAvailable(name) {
		resp.OK = false
		resp.Fallback = true
		resp.Reason = "command_not_found"
		resp.ExitCode = 127
		resp.Stderr = fmt.Sprintf("fastsh: 命令 %q 在 POSIX 环境下不可用", name)
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	// 4) 工作目录：必须真实可用，否则一律回退。
	// 绝不能在"目录无效时静默沿用上一个请求的 cwd"下继续跑，那会把 rm/cp/mv 打到错误的目录里。
	cwd := normalizeCwd(req.Cwd)
	abs, aerr := filepath.Abs(cwd)
	if aerr != nil {
		abs = cwd
	}
	if fi, serr := os.Stat(abs); serr != nil || !fi.IsDir() {
		resp.OK = false
		resp.Fallback = true
		resp.Reason = "cwd_not_found"
		resp.ExitCode = 1
		resp.Stderr = fmt.Sprintf("fastsh: 工作目录不可用: %s", abs)
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	// daemon 串行处理命令，把进程 cwd 切到请求目录，这样 coreutils shim 里的
	// 相对路径与解释器自身的重定向/cd 完全一致。
	if cerr := os.Chdir(abs); cerr != nil {
		resp.OK = false
		resp.Fallback = true
		resp.Reason = "cwd_not_found"
		resp.ExitCode = 1
		resp.Stderr = fmt.Sprintf("fastsh: 无法切换工作目录 %s: %v", abs, cerr)
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	cwd = abs

	timeoutMs := req.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	rOut, wOut, err := os.Pipe()
	if err != nil {
		resp.OK = false
		resp.Fallback = true
		resp.Reason = "pipe_error"
		resp.ExitCode = 1
		resp.Stderr = "fastsh: 创建输出管道失败: " + err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	rErr, wErr, err := os.Pipe()
	if err != nil {
		rOut.Close()
		wOut.Close()
		resp.OK = false
		resp.Fallback = true
		resp.Reason = "pipe_error"
		resp.ExitCode = 1
		resp.Stderr = "fastsh: 创建错误管道失败: " + err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	// 关键修复：读取端必须与 runner.Run 并发跑。
	// 之前是 Run 跑完再读管道，输出超过 Windows 匿名管道缓冲（实测约 4KB）后
	// 写端阻塞、Run 永不返回，daemon 直接变砖（连 echo 都不再响应）。
	outCh := readAsync(rOut)
	errCh := readAsync(rErr)

	base := interp.DefaultExecHandler(2 * time.Second)
	runner, err := interp.New(
		interp.Dir(cwd),
		interp.StdIO(strings.NewReader(""), wOut, wErr),
		interp.ExecHandler(makeExecHandler(base)),
		interp.Params(append(os.Environ(), envPairs(req.Env)...)...),
	)
	if err != nil {
		// 必须关掉写端，读取 goroutine 才会读到 EOF 并退出，否则这里就泄漏了。
		wOut.Close()
		wErr.Close()
		<-outCh
		<-errCh
		rOut.Close()
		rErr.Close()
		resp.OK = false
		resp.Fallback = true
		resp.Reason = "interp_init_error"
		resp.ExitCode = 1
		resp.Stderr = "fastsh: 解释器初始化失败: " + err.Error()
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	runErr := runner.Run(ctx, prog)
	wOut.Close()
	wErr.Close()

	outRes := <-outCh
	errRes := <-errCh
	rOut.Close()
	rErr.Close()

	resp.ExitCode = 0
	if runErr != nil {
		var es interp.ExitStatus
		if errors.As(runErr, &es) {
			resp.ExitCode = int(es)
		} else if ctx.Err() == context.DeadlineExceeded {
			resp.ExitCode = 124
			errRes.data += "\nfastsh: 命令超时"
		} else {
			resp.ExitCode = 1
			errRes.data += "\nfastsh: " + runErr.Error()
		}
	} else if ctx.Err() == context.DeadlineExceeded {
		// 命令在超时后才正常返回（例如 shim 自己看到了 ctx.Done）：仍标记为超时
		resp.ExitCode = 124
		errRes.data += "\nfastsh: 命令超时"
	}

	resp.Stdout = outRes.data
	resp.Stderr = errRes.data
	if outRes.truncated {
		resp.Stdout += fmt.Sprintf("\n[fastsh] 输出超过 %dMB 已截断", maxOutputBytes>>20)
	}
	if errRes.truncated {
		resp.Stderr += fmt.Sprintf("\n[fastsh] 错误输出超过 %dMB 已截断", maxOutputBytes>>20)
	}

	resp.OK = resp.ExitCode == 0
	resp.DurationMs = time.Since(start).Milliseconds()
	return resp
}

// pipeResult 是一个管道读取 goroutine 的结果
type pipeResult struct {
	data      string
	truncated bool
}

// readAsync 立即在 goroutine 里排空管道，返回结果通道。
// 调用方必须在关闭写端之后读取这个通道。
func readAsync(r *os.File) <-chan pipeResult {
	ch := make(chan pipeResult, 1)
	go func() {
		data, truncated := readCapped(r)
		ch <- pipeResult{data: data, truncated: truncated}
	}()
	return ch
}

// readCapped 读取内容并限制大小。
// 超过上限后**继续读取并丢弃**，否则写端会再次阻塞，重新变成死锁。
func readCapped(r io.Reader) (string, bool) {
	buf := make([]byte, 0, 64<<10)
	tmp := make([]byte, 32<<10)
	truncated := false
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			if remain := maxOutputBytes - len(buf); remain > 0 {
				if n <= remain {
					buf = append(buf, tmp[:n]...)
				} else {
					buf = append(buf, tmp[:remain]...)
					truncated = true
				}
			} else {
				truncated = true
			}
		}
		if err != nil {
			break
		}
	}
	return string(buf), truncated
}

// shimIO 是传给 coreutils shim 的标准 IO
type shimIO struct {
	stdin          io.Reader
	stdout, stderr io.Writer
}

// makeExecHandler 包装默认执行器：PATH 里找不到的命令改用 Go 原生实现。
// 注意：stdin/stdout/stderr 必须从 HandlerCtx 动态取，否则管道中上下游数据会断。
func makeExecHandler(base interp.ExecHandlerFunc) interp.ExecHandlerFunc {
	return func(ctx context.Context, args []string) error {
		if len(args) == 0 {
			return base(ctx, args)
		}
		hc := interp.HandlerCtx(ctx)
		ioSet := shimIO{stdin: hc.Stdin, stdout: hc.Stdout, stderr: hc.Stderr}
		name := normalizeCmdName(filepath.Base(args[0]))
		if fn, ok := coreutils[name]; ok {
			// shim 一律优先：Windows 上同名程序多是语义不同的古董（System32 的 sort.exe/find.exe）
			return fn(ctx, args[1:], ioSet)
		}
		return base(ctx, args)
	}
}

// normalizeCmdName 去掉 Windows 可执行后缀，统一成小写比较用的原名
func normalizeCmdName(n string) string {
	n = strings.TrimSuffix(n, ".exe")
	n = strings.TrimSuffix(n, ".EXE")
	return n
}

// normalizeCwd 把 Windows 路径转成 sh v3 可接受的形式
func normalizeCwd(cwd string) string {
	if cwd == "" {
		if wd, err := os.Getwd(); err == nil {
			return wd
		}
		return "."
	}
	// 反斜杠转正斜杠（盘符路径在 sh v3 下可用）
	if len(cwd) >= 2 && cwd[1] == ':' {
		return strings.ReplaceAll(cwd, "\\", "/")
	}
	return cwd
}

func envPairs(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

// firstCommandName 从 AST 里取第一个简单命令名（跳过前导变量赋值）
func firstCommandName(prog *syntax.File) (string, bool) {
	found := false
	var cmdName string
	syntax.Walk(prog, func(node syntax.Node) bool {
		if found {
			return false
		}
		call, ok := node.(*syntax.CallExpr)
		if !ok || len(call.Args) == 0 {
			return true
		}
		lit := call.Args[0]
		if len(lit.Parts) == 0 {
			return true
		}
		switch p := lit.Parts[0].(type) {
		case *syntax.Lit:
			cmdName = normalizeCmdName(p.Value)
		case *syntax.SglQuoted:
			cmdName = normalizeCmdName(p.Value)
		default:
			return true // 复杂表达式，跳过首命令可用性检查
		}
		found = true
		return false
	})
	return cmdName, found
}

// commandAvailable 判断命令在 POSIX 环境下是否可执行
func commandAvailable(name string) bool {
	if interp.IsBuiltin(name) {
		return true
	}
	if _, ok := coreutils[name]; ok {
		return true
	}
	// 其余交给 PATH 判定（git/node 等真实 Windows 程序）
	_, err := exec.LookPath(name)
	return err == nil
}
