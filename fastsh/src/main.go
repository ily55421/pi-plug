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
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"mvdan.cc/sh/v3/expand"
	"mvdan.cc/sh/v3/interp"
	"mvdan.cc/sh/v3/syntax"
)

// Request 是插件侧发来的单条命令请求
type Request struct {
	ID          int               `json:"id"`
	Command     string            `json:"command"`
	Cwd         string            `json:"cwd"`
	TimeoutMs   int               `json:"timeoutMs"`
	Env         map[string]string `json:"env"`
	ExpiresAt   int64             `json:"expiresAt"`
	OutputLimit *int              `json:"outputLimit"`
	Shutdown    bool              `json:"shutdown"`
}

// Response 是执行结果；Fallback=true 表示这条命令不该走 sh，应回退到 pwsh
type Response struct {
	ID              int    `json:"id"`
	OK              bool   `json:"ok"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	ExitCode        int    `json:"exitCode"`
	DurationMs      int64  `json:"durationMs"`
	Fallback        bool   `json:"fallback"`
	Reason          string `json:"reason"`
	ExecutionState  string `json:"executionState,omitempty"`
	StdoutTruncated bool   `json:"stdoutTruncated,omitempty"`
	StderrTruncated bool   `json:"stderrTruncated,omitempty"`
}

const (
	maxOutputBytes = 8 << 20   // 单次输出上限 8MB，防 OOM
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
				ID:             req.ID,
				ExecutionState: "unknown",
				Reason:         "daemon_panic",
				Stderr:         fmt.Sprintf("fastsh: 守护进程内部错误: %v", r),
				ExitCode:       1,
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
	if expired(req) {
		return expiredResponse(req.ID)
	}

	prog, err := syntax.NewParser().Parse(strings.NewReader(req.Command), "")
	if reason := powerShellReason(req.Command, prog, err); reason != "" {
		resp.Fallback = true
		resp.Reason = reason
		resp.ExitCode = 2
		if err != nil {
			resp.Stderr = "fastsh: POSIX 解析失败: " + err.Error()
		}
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	// 目录只属于本次解释器，不修改进程 cwd。
	cwd := filepath.Clean(req.Cwd)
	fi, statErr := os.Stat(cwd)
	if !filepath.IsAbs(cwd) || statErr != nil || !fi.IsDir() {
		resp.Fallback = true
		resp.Reason = "cwd_not_found"
		resp.ExitCode = 1
		resp.Stderr = fmt.Sprintf("fastsh: 工作目录不可用: %s", req.Cwd)
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}
	env := expand.ListEnviron(append(os.Environ(), envPairs(req.Env)...)...)
	// 只预检没有前置状态变更的直接命令；脚本中的后续失败不允许整段回退。
	if name, ok := firstCommandName(prog); ok && !commandAvailable(cwd, env, name) {
		resp.Fallback = true
		resp.Reason = "command_not_found"
		resp.ExitCode = 127
		resp.Stderr = fmt.Sprintf("fastsh: 命令 %q 在 POSIX 环境下不可用", name)
		resp.DurationMs = time.Since(start).Milliseconds()
		return resp
	}

	timeoutMs := req.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultTimeout
	}
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	if req.ExpiresAt != 0 && time.UnixMilli(req.ExpiresAt).Before(deadline) {
		deadline = time.UnixMilli(req.ExpiresAt)
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
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
	defer rOut.Close()
	defer wOut.Close()
	defer rErr.Close()
	defer wErr.Close()

	// 关键修复：读取端必须与 runner.Run 并发跑。
	// 之前是 Run 跑完再读管道，输出超过 Windows 匿名管道缓冲（实测约 4KB）后
	// 写端阻塞、Run 永不返回，daemon 直接变砖（连 echo 都不再响应）。
	limit := maxOutputBytes
	if req.OutputLimit != nil {
		limit = max(0, min(limit, *req.OutputLimit))
	}
	outCh := readAsync(rOut, limit)
	errCh := readAsync(rErr, limit)

	base := interp.DefaultExecHandler(2 * time.Second)
	runner, err := interp.New(
		interp.Dir(cwd),
		interp.StdIO(strings.NewReader(""), wOut, wErr),
		interp.ExecHandler(makeExecHandler(base)),
		interp.Env(env),
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

	if expired(req) {
		return expiredResponse(req.ID)
	}
	runErr := runner.Run(ctx, prog)
	wOut.Close()
	wErr.Close()

	outRes := <-outCh
	errRes := <-errCh
	rOut.Close()
	rErr.Close()

	resp.ExitCode = 0
	if ctx.Err() == context.DeadlineExceeded {
		resp.ExitCode = 124
		errRes.data += "\nfastsh: 命令超时"
	} else if runErr != nil {
		var es interp.ExitStatus
		if errors.As(runErr, &es) {
			resp.ExitCode = int(es)
		} else {
			resp.ExitCode = 1
			errRes.data += "\nfastsh: " + runErr.Error()
		}
	}

	resp.Stdout, resp.StdoutTruncated = capText(outRes.data, limit, outRes.truncated)
	resp.Stderr, resp.StderrTruncated = capText(errRes.data, limit-len(resp.Stdout), errRes.truncated)

	resp.OK = resp.ExitCode == 0
	resp.DurationMs = time.Since(start).Milliseconds()
	return resp
}

func expired(req Request) bool {
	return req.ExpiresAt != 0 && time.Now().UnixMilli() >= req.ExpiresAt
}

func expiredResponse(id int) Response {
	return Response{ID: id, ExecutionState: "not_started", Reason: "request_expired", ExitCode: 124}
}

func capText(text string, limit int, truncated bool) (string, bool) {
	// 归一化无效文本，保证 JSON 序列化不会在截断后扩大字节数。
	text = strings.ToValidUTF8(text, "\uFFFD")
	if len(text) <= limit {
		return text, truncated
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end], true
}

// pipeResult 是一个管道读取 goroutine 的结果
type pipeResult struct {
	data      string
	truncated bool
}

// readAsync 立即在 goroutine 里排空管道，返回结果通道。
// 调用方必须在关闭写端之后读取这个通道。
func readAsync(r *os.File, limit int) <-chan pipeResult {
	ch := make(chan pipeResult, 1)
	go func() {
		data, truncated := readCapped(r, limit)
		ch <- pipeResult{data: data, truncated: truncated}
	}()
	return ch
}

// readCapped 读取内容并限制大小。
// 超过上限后**继续读取并丢弃**，否则写端会再次阻塞，重新变成死锁。
func readCapped(r io.Reader, limit int) (string, bool) {
	buf := make([]byte, 0, min(64<<10, limit))
	tmp := make([]byte, 32<<10)
	truncated := false
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			if remain := limit - len(buf); remain > 0 {
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
	dir            string
}

// resolvePath 让文件操作与 cd、子 shell、重定向共享同一个解释器目录。
func (s shimIO) resolvePath(p string) string {
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	if runtime.GOOS == "windows" && os.IsPathSeparator(p[0]) {
		return filepath.VolumeName(s.dir) + p
	}
	return filepath.Join(s.dir, p)
}

// makeExecHandler 包装默认执行器：PATH 里找不到的命令改用 Go 原生实现。
// 注意：stdin/stdout/stderr 必须从 HandlerCtx 动态取，否则管道中上下游数据会断。
func makeExecHandler(base interp.ExecHandlerFunc) interp.ExecHandlerFunc {
	return func(ctx context.Context, args []string) error {
		if len(args) == 0 {
			return base(ctx, args)
		}
		hc := interp.HandlerCtx(ctx)
		ioSet := shimIO{stdin: hc.Stdin, stdout: hc.Stdout, stderr: hc.Stderr, dir: hc.Dir}
		name := normalizeCmdName(args[0])
		if fn, ok := coreutils[name]; ok {
			// shim 一律优先：Windows 上同名程序多是语义不同的古董（System32 的 sort.exe/find.exe）
			return fn(ctx, args[1:], ioSet)
		}
		return base(ctx, args)
	}
}

// 只拦截裸命令名；显式路径必须按实际程序执行。
func normalizeCmdName(n string) string {
	if strings.EqualFold(filepath.Ext(n), ".exe") {
		return n[:len(n)-4]
	}
	return n
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

// 脚本里可重新定义命令或修改 PATH，只预检开头直接出现的简单调用。
func firstCommandName(prog *syntax.File) (string, bool) {
	if len(prog.Stmts) > 0 {
		if call, ok := prog.Stmts[0].Cmd.(*syntax.CallExpr); ok && len(call.Assigns) == 0 && len(call.Args) > 0 {
			return literalWord(call.Args[0])
		}
	}
	return "", false
}

func commandAvailable(cwd string, env expand.Environ, name string) bool {
	if interp.IsBuiltin(name) {
		return true
	}
	if _, ok := coreutils[normalizeCmdName(name)]; ok {
		return true
	}
	_, err := interp.LookPathDir(cwd, env, name)
	return err == nil
}
