package main

// coreutils.go：用 Go 原生实现 Windows 上缺失的 POSIX 核心工具。
// 当 ExecHandler 发现 PATH 里找不到某命令、而我们有原生实现时启用。
import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"mvdan.cc/sh/v3/interp"
)

type shimFunc func(ctx context.Context, args []string, io shimIO) error

// coreutils 注册表：命令名 -> 实现
var coreutils = map[string]shimFunc{
	"ls":       shimLs,
	"cat":      shimCat,
	"cp":       shimCp,
	"mv":       shimMv,
	"rm":       shimRm,
	"mkdir":    shimMkdir,
	"rmdir":    shimRmdir,
	"touch":    shimTouch,
	"wc":       shimWc,
	"head":     shimHead,
	"tail":     shimTail,
	"seq":      shimSeq,
	"yes":      shimYes,
	"sleep":    shimSleep,
	"date":     shimDate,
	"env":      shimEnv,
	"printenv": shimEnv,
	"stat":     shimStat,
	"dirname":  shimDirname,
	"basename": shimBasename,
	"tr":       shimTr,
	"true":     shimTrue,
	"false":    shimFalse,
	"pwd":      shimPwd,
	"which":    shimWhich,
}

// ---------- 辅助 ----------

func readAllStdin(r io.Reader) []byte {
	if r == nil {
		return nil
	}
	b, _ := io.ReadAll(r)
	return b
}

func splitLines(b []byte) []string {
	s := string(b)
	s = strings.TrimSuffix(s, "\n")
	s = strings.TrimSuffix(s, "\r")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func out(io shimIO, s string) { fmt.Fprint(io.stdout, s) }

func errOut(io shimIO, s string) { fmt.Fprint(io.stderr, s) }

// exitCode 让 shim 返回正确的退出码；interp.ExitStatus 会被 interp 识别为退出码而非普通错误
func exitCode(n int) error { return interp.ExitStatus(n) }

// isFlag 判断是否为选项（含组合短选项）
// posixDir 取 POSIX 路径的目录部分，避免 filepath.Dir 在 Windows 上返回反斜杠形式
func posixDir(p string) string {
	i := strings.LastIndex(p, "/")
	if i < 0 {
		return "."
	}
	if i == 0 {
		return "/"
	}
	return p[:i]
}

func isFlag(a string) bool { return len(a) > 1 && a[0] == '-' && a != "-" && a != "--" }

// isAllDigits 判断是否全为数字，用于 head -3 / tail -3 这类老式写法
func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// ---------- ls ----------

func shimLs(ctx context.Context, args []string, io shimIO) error {
	long, all, one, human, recursive := false, false, false, false, false
	var paths []string
	for _, a := range args {
		if !isFlag(a) {
			paths = append(paths, a)
			continue
		}
		for _, c := range strings.TrimLeft(a, "-") {
			switch c {
			case 'l':
				long = true
			case 'a':
				all = true
			case '1':
				one = true
			case 'h':
				human = true
			case 'R':
				recursive = true
			}
		}
	}
	if len(paths) == 0 {
		paths = []string{"."}
	}
	for _, p := range paths {
		entries, err := os.ReadDir(io.resolvePath(p))
		if err != nil {
			// 单文件参数：ls -l file 应显示该文件本身
			if info, serr := os.Stat(io.resolvePath(p)); serr == nil && !info.IsDir() {
				sz := strconv.FormatInt(info.Size(), 10)
				if human {
					sz = humanSize(info.Size())
				}
				kind := "-"
				if info.Mode()&os.ModeSymlink != 0 {
					kind = "l"
				}
				out(io, fmt.Sprintf("%s %10s %s %s\n", kind, sz, info.ModTime().Format("2006-01-02 15:04"), filepath.Base(p)))
				continue
			}
			errOut(io, fmt.Sprintf("ls: %s: %v\n", p, err))
			continue
		}
		if !all {
			filtered := entries[:0]
			for _, e := range entries {
				if !strings.HasPrefix(e.Name(), ".") {
					filtered = append(filtered, e)
				}
			}
			entries = filtered
		}
		if long {
			for _, e := range entries {
				info, err := e.Info()
				if err != nil {
					continue
				}
				size := info.Size()
				sz := strconv.FormatInt(size, 10)
				if human {
					sz = humanSize(size)
				}
				kind := "-"
				if e.IsDir() {
					kind = "d"
				} else if info.Mode()&os.ModeSymlink != 0 {
					kind = "l"
				}
				out(io, fmt.Sprintf("%s %10s %s %s\n", kind, sz, info.ModTime().Format("2006-01-02 15:04"), e.Name()))
			}
		} else {
			for _, e := range entries {
				out(io, e.Name()+"\n")
			}
		}
		_ = one
		if recursive {
			for _, e := range entries {
				if e.IsDir() && (all || !strings.HasPrefix(e.Name(), ".")) {
					sub := filepath.Join(p, e.Name())
					out(io, "\n"+sub+":\n")
					shimLs(ctx, []string{sub}, io)
				}
			}
		}
	}
	return nil
}

func humanSize(n int64) string {
	f := float64(n)
	for _, u := range []string{"", "K", "M", "G", "T"} {
		if f < 1024 {
			return fmt.Sprintf("%.1f%s", f, u)
		}
		f /= 1024
	}
	return fmt.Sprintf("%.1fP", f)
}

// ---------- cat ----------

func shimCat(ctx context.Context, args []string, io shimIO) error {
	numbered := false
	var files []string
	for _, a := range args {
		switch {
		case a == "-n" || a == "--number":
			numbered = true
		case a == "-b":
			numbered = true
		case !isFlag(a):
			files = append(files, a)
		}
	}
	if len(files) == 0 {
		files = []string{"-"}
	}
	lineNo := 1
	for _, f := range files {
		var data []byte
		if f == "-" {
			data = readAllStdin(io.stdin)
		} else {
			b, err := os.ReadFile(io.resolvePath(f))
			if err != nil {
				errOut(io, fmt.Sprintf("cat: %s: %v\n", f, err))
				return exitCode(1)
			}
			data = b
		}
		if numbered {
			for _, l := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
				out(io, fmt.Sprintf("%6d\t%s\n", lineNo, l))
				lineNo++
			}
		} else {
			out(io, string(data))
		}
	}
	return nil
}

// ---------- cp / mv / rm ----------

func shimCp(ctx context.Context, args []string, io shimIO) error {
	recursive, force := false, false
	var rest []string
	for _, a := range args {
		switch {
		case a == "-r" || a == "-R" || a == "--recursive":
			recursive = true
		case a == "-f" || a == "--force":
			force = true
		case a == "-v":
			// 详细输出，忽略
		case !isFlag(a):
			rest = append(rest, a)
		}
	}
	if len(rest) < 2 {
		errOut(io, "cp: 需要源和目标\n")
		return exitCode(1)
	}
	src, dst := io.resolvePath(rest[0]), io.resolvePath(rest[1])
	srcInfo, err := os.Stat(src)
	if err != nil {
		errOut(io, fmt.Sprintf("cp: %v\n", err))
		return exitCode(1)
	}
	if srcInfo.IsDir() && !recursive {
		errOut(io, fmt.Sprintf("cp: %s 是目录（需要 -r）\n", src))
		return exitCode(1)
	}
	if srcInfo.IsDir() {
		return copyDir(src, dst, io, force)
	}
	if err := copyFile(src, dst); err != nil {
		errOut(io, fmt.Sprintf("cp: %v\n", err))
		return exitCode(1)
	}
	return nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dst, data, info.Mode()); err != nil {
		return err
	}
	return nil
}

func copyDir(src, dst string, io shimIO, force bool) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		if e.IsDir() {
			if err := copyDir(s, d, io, force); err != nil {
				return err
			}
		} else {
			if err := copyFile(s, d); err != nil {
				return err
			}
		}
	}
	return nil
}

func shimMv(ctx context.Context, args []string, io shimIO) error {
	var rest []string
	for _, a := range args {
		if !isFlag(a) {
			rest = append(rest, a)
		}
	}
	if len(rest) < 2 {
		errOut(io, "mv: 需要源和目标\n")
		return exitCode(1)
	}
	rest[0], rest[1] = io.resolvePath(rest[0]), io.resolvePath(rest[1])
	if err := os.Rename(rest[0], rest[1]); err != nil {
		// 跨设备：复制后删除
		data, rerr := os.ReadFile(rest[0])
		if rerr != nil {
			errOut(io, fmt.Sprintf("mv: %v\n", err))
			return exitCode(1)
		}
		if werr := os.WriteFile(rest[1], data, 0o644); werr != nil {
			errOut(io, fmt.Sprintf("mv: %v\n", werr))
			return exitCode(1)
		}
		os.Remove(rest[0])
	}
	return nil
}

func shimRm(ctx context.Context, args []string, io shimIO) error {
	recursive, force := false, false
	var rest []string
	for _, a := range args {
		switch {
		case a == "-r" || a == "-R" || a == "--recursive":
			recursive = true
		case a == "-f" || a == "--force":
			force = true
		case strings.HasPrefix(a, "-") && strings.ContainsAny(a, "rf"):
			recursive = recursive || strings.ContainsAny(a, "rR")
			force = force || strings.Contains(a, "f")
		case !isFlag(a):
			rest = append(rest, a)
		}
	}
	code := 0
	for _, p := range rest {
		var err error
		if recursive {
			err = os.RemoveAll(io.resolvePath(p))
		} else {
			err = os.Remove(io.resolvePath(p))
			if err != nil && !force {
				if fi, serr := os.Stat(io.resolvePath(p)); serr == nil && fi.IsDir() {
					errOut(io, fmt.Sprintf("rm: %s 是目录（需要 -r）\n", p))
				}
			}
		}
		if err != nil && !force {
			errOut(io, fmt.Sprintf("rm: %v\n", err))
			code = 1
		}
	}
	if code != 0 {
		return exitCode(code)
	}
	return nil
}

// ---------- mkdir / rmdir / touch ----------

func shimMkdir(ctx context.Context, args []string, io shimIO) error {
	parents := false
	var rest []string
	for _, a := range args {
		switch {
		case a == "-p" || a == "--parents":
			parents = true
		case !isFlag(a):
			rest = append(rest, a)
		}
	}
	code := 0
	for _, d := range rest {
		var err error
		if parents {
			err = os.MkdirAll(io.resolvePath(d), 0o755)
		} else {
			err = os.Mkdir(io.resolvePath(d), 0o755)
		}
		if err != nil {
			errOut(io, fmt.Sprintf("mkdir: %v\n", err))
			code = 1
		}
	}
	if code != 0 {
		return exitCode(code)
	}
	return nil
}

func shimRmdir(ctx context.Context, args []string, io shimIO) error {
	code := 0
	for _, a := range args {
		if isFlag(a) {
			continue
		}
		if err := os.Remove(io.resolvePath(a)); err != nil {
			errOut(io, fmt.Sprintf("rmdir: %v\n", err))
			code = 1
		}
	}
	if code != 0 {
		return exitCode(code)
	}
	return nil
}

func shimTouch(ctx context.Context, args []string, io shimIO) error {
	now := time.Now()
	code := 0
	for _, a := range args {
		if isFlag(a) {
			continue
		}
		p := io.resolvePath(a)
		if _, err := os.Stat(p); os.IsNotExist(err) {
			f, err := os.Create(p)
			if err != nil {
				errOut(io, fmt.Sprintf("touch: %v\n", err))
				code = 1
				continue
			}
			f.Close()
		} else {
			if err := os.Chtimes(p, now, now); err != nil {
				errOut(io, fmt.Sprintf("touch: %v\n", err))
				code = 1
			}
		}
	}
	if code != 0 {
		return exitCode(code)
	}
	return nil
}

// ---------- wc ----------

func shimWc(ctx context.Context, args []string, io shimIO) error {
	wantLines, wantWords, wantBytes, wantChars := false, false, false, false
	var files []string
	for _, a := range args {
		switch {
		case a == "-l" || a == "--lines":
			wantLines = true
		case a == "-w" || a == "--words":
			wantWords = true
		case a == "-c" || a == "--bytes":
			wantBytes = true
		case a == "-m" || a == "--chars":
			// -m 是字符数（按 rune 计），不是字节数。
			// 原来把 -m 当成 -c，中文会被算成 9 而不是 5，属于静默错误答案。
			wantChars = true
		case !isFlag(a):
			files = append(files, a)
		}
	}
	if !wantLines && !wantWords && !wantBytes && !wantChars {
		wantLines, wantWords, wantBytes = true, true, true
	}
	total := [4]int{} // lines, words, bytes, chars
	report := func(name string, data []byte) {
		lines := strings.Count(string(data), "\n")
		words := len(strings.Fields(string(data)))
		nBytes := len(data)
		nChars := utf8.RuneCount(data)
		total[0] += lines
		total[1] += words
		total[2] += nBytes
		total[3] += nChars
		parts := []string{}
		if wantLines {
			parts = append(parts, strconv.Itoa(lines))
		}
		if wantWords {
			parts = append(parts, strconv.Itoa(words))
		}
		if wantBytes {
			parts = append(parts, strconv.Itoa(nBytes))
		}
		if wantChars {
			parts = append(parts, strconv.Itoa(nChars))
		}
		out(io, strings.Join(parts, " ")+" "+name+"\n")
	}
	if len(files) == 0 {
		report("", readAllStdin(io.stdin))
		return nil
	}
	for _, f := range files {
		b, err := os.ReadFile(io.resolvePath(f))
		if err != nil {
			errOut(io, fmt.Sprintf("wc: %v\n", err))
			return exitCode(1)
		}
		report(f, b)
	}
	if len(files) > 1 {
		parts := []string{}
		if wantLines {
			parts = append(parts, strconv.Itoa(total[0]))
		}
		if wantWords {
			parts = append(parts, strconv.Itoa(total[1]))
		}
		if wantBytes {
			parts = append(parts, strconv.Itoa(total[2]))
		}
		if wantChars {
			parts = append(parts, strconv.Itoa(total[3]))
		}
		out(io, strings.Join(parts, " ")+" total\n")
	}
	return nil
}

// ---------- head / tail ----------

func shimHead(ctx context.Context, args []string, io shimIO) error {
	n := 10
	var files []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-n" && i+1 < len(args):
			i++
			if v, err := strconv.Atoi(strings.TrimPrefix(args[i], "+")); err == nil {
				n = v
			}
		case strings.HasPrefix(a, "-n") && len(a) > 2:
			if v, err := strconv.Atoi(strings.TrimPrefix(a[2:], "+")); err == nil {
				n = v
			}
		case isFlag(a) && isAllDigits(a[1:]):
			// 老式写法 head -3：之前被静默忽略，退化成默认 10 行，属于"不报错但答案错"。
			if v, err := strconv.Atoi(a[1:]); err == nil {
				n = v
			}
		case !isFlag(a):
			files = append(files, a)
		}
	}
	if len(files) == 0 {
		lines := splitLines(readAllStdin(io.stdin))
		for _, l := range firstN(lines, n) {
			out(io, l+"\n")
		}
		return nil
	}
	for _, f := range files {
		b, err := os.ReadFile(io.resolvePath(f))
		if err != nil {
			errOut(io, fmt.Sprintf("head: %v\n", err))
			return exitCode(1)
		}
		for _, l := range firstN(splitLines(b), n) {
			out(io, l+"\n")
		}
	}
	return nil
}

func shimTail(ctx context.Context, args []string, io shimIO) error {
	n := 10
	fromStart := false // tail -n +N：从第 N 行开始一直输出到末尾
	var files []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-n" && i+1 < len(args):
			i++
			v := args[i]
			if strings.HasPrefix(v, "+") {
				fromStart = true
				v = v[1:]
			}
			if x, err := strconv.Atoi(v); err == nil {
				n = x
			}
		case strings.HasPrefix(a, "-n") && len(a) > 2:
			v := a[2:]
			if strings.HasPrefix(v, "+") {
				fromStart = true
				v = v[1:]
			}
			if x, err := strconv.Atoi(v); err == nil {
				n = x
			}
		case a == "-f" || a == "--follow":
			errOut(io, "tail: -f 跟随模式在快速通道中不支持，请用内置 Bash\n")
			return exitCode(1)
		case isFlag(a) && isAllDigits(a[1:]):
			// 老式写法 tail -3
			if x, err := strconv.Atoi(a[1:]); err == nil {
				n = x
			}
		case !isFlag(a):
			files = append(files, a)
		}
	}

	// selectTail 按 tail 语义挑选要输出的行
	selectTail := func(lines []string) []string {
		if fromStart {
			idx := n - 1
			if idx < 0 {
				idx = 0
			}
			if idx >= len(lines) {
				return nil
			}
			return lines[idx:]
		}
		if n <= 0 {
			return nil
		}
		if len(lines) > n {
			return lines[len(lines)-n:]
		}
		return lines
	}
	emit := func(lines []string) {
		for _, l := range selectTail(lines) {
			out(io, l+"\n")
		}
	}

	if len(files) == 0 {
		emit(splitLines(readAllStdin(io.stdin)))
		return nil
	}
	for _, f := range files {
		b, err := os.ReadFile(io.resolvePath(f))
		if err != nil {
			errOut(io, fmt.Sprintf("tail: %v\n", err))
			return exitCode(1)
		}
		emit(splitLines(b))
	}
	return nil
}

func firstN(s []string, n int) []string {
	if n >= len(s) {
		return s
	}
	if n < 0 {
		n = 0
	}
	return s[:n]
}

// ---------- seq / yes / sleep / date ----------

func shimSeq(ctx context.Context, args []string, io shimIO) error {
	var nums []float64
	for _, a := range args {
		if v, err := strconv.ParseFloat(a, 64); err == nil {
			nums = append(nums, v)
		} else {
			errOut(io, fmt.Sprintf("seq: 非法参数 %q\n", a))
			return exitCode(1)
		}
	}
	start, step, end := 1.0, 1.0, 0.0
	switch len(nums) {
	case 1:
		end = nums[0]
	case 2:
		start, end = nums[0], nums[1]
	case 3:
		start, step, end = nums[0], nums[1], nums[2]
	default:
		errOut(io, "seq: 参数个数不对\n")
		return exitCode(1)
	}
	if step == 0 {
		return exitCode(1)
	}
	for v := start; (step > 0 && v <= end) || (step < 0 && v >= end); v += step {
		if v == float64(int64(v)) {
			out(io, fmt.Sprintf("%d\n", int64(v)))
		} else {
			out(io, fmt.Sprintf("%g\n", v))
		}
	}
	return nil
}

func shimYes(ctx context.Context, args []string, io shimIO) error {
	s := "y"
	if len(args) > 0 {
		s = strings.Join(args, " ")
	}
	for i := 0; i < 100000; i++ {
		if _, err := fmt.Fprintln(io.stdout, s); err != nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		default:
		}
	}
	return nil
}

func shimSleep(ctx context.Context, args []string, io shimIO) error {
	for _, a := range args {
		if isFlag(a) {
			continue
		}
		v, err := strconv.ParseFloat(a, 64)
		if err != nil {
			errOut(io, fmt.Sprintf("sleep: 非法时长 %q\n", a))
			return exitCode(1)
		}
		d := time.Duration(v * float64(time.Second))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(d):
		}
	}
	return nil
}

func shimDate(ctx context.Context, args []string, io shimIO) error {
	now := time.Now()
	format := ""
	for _, a := range args {
		if strings.HasPrefix(a, "+") {
			format = a[1:]
		}
	}
	if format == "" {
		out(io, now.Format("Mon Jan  2 15:04:05 MST 2006")+"\n")
		return nil
	}
	repl := strings.NewReplacer(
		"%Y", now.Format("2006"),
		"%m", now.Format("01"),
		"%d", now.Format("02"),
		"%H", now.Format("15"),
		"%M", now.Format("04"),
		"%S", now.Format("05"),
		"%F", now.Format("2006-01-02"),
		"%T", now.Format("15:04:05"),
		"%s", strconv.FormatInt(now.Unix(), 10),
		"%%", "%",
	)
	out(io, repl.Replace(format)+"\n")
	return nil
}

// ---------- env / stat / dirname / basename / tr / which ----------

func shimEnv(ctx context.Context, args []string, io shimIO) error {
	// 过滤掉 env 自己的参数（如 -i）
	for _, a := range args {
		if !isFlag(a) {
			errOut(io, fmt.Sprintf("env: 不支持执行命令 %q，请用内置 Bash\n", a))
			return exitCode(1)
		}
	}
	for _, kv := range os.Environ() {
		out(io, kv+"\n")
	}
	return nil
}

func shimStat(ctx context.Context, args []string, io shimIO) error {
	for _, a := range args {
		if isFlag(a) {
			continue
		}
		info, err := os.Stat(io.resolvePath(a))
		if err != nil {
			errOut(io, fmt.Sprintf("stat: %v\n", err))
			return exitCode(1)
		}
		kind := "regular file"
		if info.IsDir() {
			kind = "directory"
		}
		out(io, fmt.Sprintf("  File: %s\n  Size: %d\n  Type: %s\n  Modify: %s\n",
			a, info.Size(), kind, info.ModTime().Format("2006-01-02 15:04:05")))
	}
	return nil
}

func shimDirname(ctx context.Context, args []string, io shimIO) error {
	for _, a := range args {
		if isFlag(a) {
			continue
		}
		d := posixDir(strings.ReplaceAll(a, "\\", "/"))
		if d == "" {
			d = "."
		}
		out(io, d+"\n")
	}
	return nil
}

func shimBasename(ctx context.Context, args []string, io shimIO) error {
	for _, a := range args {
		if isFlag(a) {
			continue
		}
		out(io, filepath.Base(strings.ReplaceAll(a, "\\", "/"))+"\n")
	}
	return nil
}

func shimTr(ctx context.Context, args []string, io shimIO) error {
	deleteMode := false
	var sets []string
	for _, a := range args {
		switch {
		case a == "-d" || a == "--delete":
			deleteMode = true
		case !isFlag(a):
			sets = append(sets, a)
		}
	}
	if len(sets) < 1 {
		errOut(io, "tr: 用法 tr [-d] 集合1 [集合2]\n")
		return exitCode(1)
	}
	from := expandTrSet(sets[0])
	var to []rune
	if len(sets) > 1 {
		to = expandTrSet(sets[1])
	}
	mapping := map[rune]rune{}
	for i, r := range from {
		if deleteMode {
			mapping[r] = -1
			continue
		}
		if i < len(to) {
			mapping[r] = to[i]
		} else if len(to) > 0 {
			mapping[r] = to[len(to)-1]
		}
	}
	data := string(readAllStdin(io.stdin))
	var b strings.Builder
	for _, r := range data {
		if m, ok := mapping[r]; ok {
			if m == -1 {
				continue
			}
			b.WriteRune(m)
		} else {
			b.WriteRune(r)
		}
	}
	out(io, b.String())
	return nil
}

// expandTrSet 展开 tr 的字符集：支持 a-z 范围与 \n \t \\ 转义
func expandTrSet(s string) []rune {
	var out []rune
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		if runes[i] == '\\' && i+1 < len(runes) {
			switch runes[i+1] {
			case 'n':
				out = append(out, '\n')
				i++
				continue
			case 't':
				out = append(out, '\t')
				i++
				continue
			case '\\':
				out = append(out, '\\')
				i++
				continue
			}
		}
		if i+2 < len(runes) && runes[i+1] == '-' {
			lo, hi := runes[i], runes[i+2]
			if lo <= hi {
				for c := lo; c <= hi; c++ {
					out = append(out, c)
				}
				i += 2
				continue
			}
		}
		out = append(out, runes[i])
	}
	return out
}

func shimWhich(ctx context.Context, args []string, io shimIO) error {
	code := 0
	for _, a := range args {
		if isFlag(a) {
			continue
		}
		if p, err := interp.LookPathDir(io.dir, interp.HandlerCtx(ctx).Env, a); err == nil {
			out(io, p+"\n")
		} else if interp.IsBuiltin(a) {
			out(io, a+": shell builtin\n")
		} else {
			code = 1
		}
	}
	if code != 0 {
		return exitCode(code)
	}
	return nil
}

// ---------- true / false / pwd ----------

func shimTrue(ctx context.Context, args []string, io shimIO) error  { return nil }
func shimFalse(ctx context.Context, args []string, io shimIO) error { return exitCode(1) }

func shimPwd(ctx context.Context, args []string, io shimIO) error {
	out(io, io.dir+"\n")
	return nil
}
