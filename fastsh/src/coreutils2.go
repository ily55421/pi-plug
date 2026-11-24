package main

// coreutils2.go：文本处理类 shim（grep/sed/sort/uniq/find）。
// 这些命令在 Windows 上要么缺失，要么 System32 里有同名但语义完全不同的古董程序
// （如 sort.exe/find.exe），因此必须由 shim 优先接管，不能回退到 PATH。
import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// registerExtra 在 init 中把文本处理命令注册进 coreutils 表
func init() {
	coreutils["grep"] = shimGrep
	coreutils["sed"] = shimSed
	coreutils["sort"] = shimSort
	coreutils["uniq"] = shimUniq
	coreutils["find"] = shimFind
}

// ---------- grep ----------

func shimGrep(ctx context.Context, args []string, io shimIO) error {
	ignoreCase, invert, lineNum, countOnly, filesOnly, recursive := false, false, false, false, false, false
	var pattern string
	var files []string
	havePattern := false

	noMoreFlags := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if noMoreFlags {
			if !havePattern {
				pattern = a
				havePattern = true
			} else {
				files = append(files, a)
			}
			continue
		}
		// -- 之后一律按位置参数处理：grep -- -x 里的 -x 是模式而不是选项。
		// 之前把 -- 当成组合短选项吞掉，-x 也被当选项，最后报"缺少匹配模式"。
		if a == "--" {
			noMoreFlags = true
			continue
		}
		switch {
		case a == "-i" || a == "--ignore-case":
			ignoreCase = true
		case a == "-v" || a == "--invert-match":
			invert = true
		case a == "-n" || a == "--line-number":
			lineNum = true
		case a == "-c" || a == "--count":
			countOnly = true
		case a == "-l" || a == "--files-with-matches":
			filesOnly = true
		case a == "-r" || a == "-R" || a == "--recursive":
			recursive = true
		case a == "-E" || a == "--extended-regexp":
			// Go regexp 默认即 ERE 风格，忽略
		case a == "-e" && i+1 < len(args):
			i++
			pattern = args[i]
			havePattern = true
		case strings.HasPrefix(a, "-") && len(a) > 1 && !havePattern:
			// 组合短选项，如 -in
			for _, c := range a[1:] {
				switch c {
				case 'i':
					ignoreCase = true
				case 'v':
					invert = true
				case 'n':
					lineNum = true
				case 'c':
					countOnly = true
				case 'l':
					filesOnly = true
				case 'r', 'R':
					recursive = true
				}
			}
		case !havePattern:
			pattern = a
			havePattern = true
		case !isFlag(a):
			files = append(files, a)
		}
	}
	if !havePattern {
		errOut(io, "grep: 缺少匹配模式\n")
		return exitCode(2)
	}

	expr := pattern
	if ignoreCase {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		errOut(io, fmt.Sprintf("grep: 正则错误: %v\n", err))
		return exitCode(2)
	}

	matched := false
	emit := func(name string, data []byte) {
		lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
		if string(data) == "" {
			lines = nil
		}
		hits := 0
		for idx, l := range lines {
			ok := re.MatchString(strings.TrimSuffix(l, "\r"))
			if invert {
				ok = !ok
			}
			if !ok {
				continue
			}
			hits++
			matched = true
			if filesOnly {
				out(io, name+"\n")
				return
			}
			if countOnly {
				continue
			}
			prefix := ""
			if lineNum {
				prefix = strconv.Itoa(idx+1) + ":"
			}
			if len(files) > 1 || recursive {
				prefix = name + ":" + prefix
			}
			out(io, prefix+strings.TrimSuffix(l, "\r")+"\n")
		}
		if countOnly {
			prefix := ""
			if len(files) > 1 || recursive {
				prefix = name + ":"
			}
			out(io, prefix+strconv.Itoa(hits)+"\n")
		}
	}

	if len(files) == 0 {
		emit("(standard input)", readAllStdin(io.stdin))
	} else {
		for _, f := range files {
			if recursive {
				root := io.resolvePath(f)
				filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
					if err != nil || info.IsDir() {
						return nil
					}
					b, rerr := os.ReadFile(p)
					if rerr == nil {
						rel, _ := filepath.Rel(root, p)
						emit(filepath.Join(f, rel), b)
					}
					return nil
				})
				continue
			}
			b, err := os.ReadFile(io.resolvePath(f))
			if err != nil {
				errOut(io, fmt.Sprintf("grep: %v\n", err))
				return exitCode(2)
			}
			emit(f, b)
		}
	}
	if !matched {
		return exitCode(1)
	}
	return nil
}

// ---------- sed（支持 s/pattern/replacement/[g|I]） ----------

func shimSed(ctx context.Context, args []string, io shimIO) error {
	var script string
	var files []string
	for _, a := range args {
		if !isFlag(a) && script == "" {
			script = a
			continue
		}
		if !isFlag(a) {
			files = append(files, a)
		}
	}
	if script == "" {
		errOut(io, "sed: 缺少脚本（当前仅支持 s/pattern/replacement/[g]）\n")
		return exitCode(1)
	}
	if !strings.HasPrefix(script, "s") {
		errOut(io, "sed: 快速通道仅支持 s 替换命令，其他用法请用内置 Bash\n")
		return exitCode(1)
	}
	delim := script[1:2]
	pat, rep, flags, perr := parseSCommand(script[2:], delim[0])
	if perr != nil {
		errOut(io, "sed: "+perr.Error()+"\n")
		return exitCode(1)
	}
	expr := pat
	if strings.Contains(flags, "I") {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		errOut(io, fmt.Sprintf("sed: 正则错误: %v\n", err))
		return exitCode(1)
	}
	// sed 替换串里的 $ 是字面量，而 Go 的 ReplaceAllString 会展开 $1/$name，
	// 必须转义成 $$ 才能保持 sed 语义。
	repl := strings.ReplaceAll(rep, "$", "$$")
	replacer := func(in string) string {
		if strings.Contains(flags, "g") {
			return re.ReplaceAllString(in, repl)
		}
		loc := re.FindStringIndex(in)
		if loc == nil {
			return in
		}
		return in[:loc[0]] + re.ReplaceAllString(in[loc[0]:loc[1]], repl) + in[loc[1]:]
	}

	apply := func(data []byte) {
		for _, l := range splitLines(data) {
			out(io, replacer(l)+"\n")
		}
	}
	if len(files) == 0 {
		apply(readAllStdin(io.stdin))
	} else {
		for _, f := range files {
			b, err := os.ReadFile(io.resolvePath(f))
			if err != nil {
				errOut(io, fmt.Sprintf("sed: %v\n", err))
				continue
			}
			apply(b)
		}
	}
	return nil
}

// ---------- sort ----------

func shimSort(ctx context.Context, args []string, io shimIO) error {
	reverse, numeric, unique := false, false, false
	var files []string
	for _, a := range args {
		switch {
		case a == "-r" || a == "--reverse":
			reverse = true
		case a == "-n" || a == "--numeric-sort":
			numeric = true
		case a == "-u" || a == "--unique":
			unique = true
		case !isFlag(a):
			files = append(files, a)
		}
	}
	var lines []string
	if len(files) == 0 {
		lines = splitLines(readAllStdin(io.stdin))
	} else {
		for _, f := range files {
			b, err := os.ReadFile(io.resolvePath(f))
			if err != nil {
				errOut(io, fmt.Sprintf("sort: %v\n", err))
				return exitCode(2)
			}
			lines = append(lines, splitLines(b)...)
		}
	}
	less := func(i, j int) bool {
		if numeric {
			a, _ := strconv.ParseFloat(strings.TrimSpace(lines[i]), 64)
			b, _ := strconv.ParseFloat(strings.TrimSpace(lines[j]), 64)
			return a < b
		}
		return lines[i] < lines[j]
	}
	sort.SliceStable(lines, less)
	if reverse {
		for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
			lines[i], lines[j] = lines[j], lines[i]
		}
	}
	prev := ""
	for i, l := range lines {
		if unique && i > 0 && l == prev {
			continue
		}
		prev = l
		out(io, l+"\n")
	}
	return nil
}

// ---------- uniq ----------

func shimUniq(ctx context.Context, args []string, io shimIO) error {
	countMode, onlyDup, onlyUniq := false, false, false
	var files []string
	for _, a := range args {
		switch {
		case a == "-c" || a == "--count":
			countMode = true
		case a == "-d" || a == "--repeated":
			onlyDup = true
		case a == "-u" || a == "--unique":
			onlyUniq = true
		case !isFlag(a):
			files = append(files, a)
		}
	}
	var lines []string
	if len(files) == 0 {
		lines = splitLines(readAllStdin(io.stdin))
	} else {
		for _, f := range files {
			b, err := os.ReadFile(io.resolvePath(f))
			if err != nil {
				errOut(io, fmt.Sprintf("uniq: %v\n", err))
				return exitCode(2)
			}
			lines = append(lines, splitLines(b)...)
		}
	}
	for i := 0; i < len(lines); {
		j := i
		for j < len(lines) && lines[j] == lines[i] {
			j++
		}
		n := j - i
		switch {
		case onlyDup && n < 2:
		case onlyUniq && n > 1:
		case countMode:
			out(io, fmt.Sprintf("%4d %s\n", n, lines[i]))
		default:
			out(io, lines[i]+"\n")
		}
		i = j
	}
	return nil
}

// ---------- find ----------

func shimFind(ctx context.Context, args []string, io shimIO) error {
	var roots []string
	var namePat string
	typeFilter := ""
	maxDepth := -1

	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-name" && i+1 < len(args):
			i++
			namePat = args[i]
		case a == "-type" && i+1 < len(args):
			i++
			typeFilter = args[i]
		case a == "-maxdepth" && i+1 < len(args):
			i++
			if v, err := strconv.Atoi(args[i]); err == nil {
				maxDepth = v
			}
		case strings.HasPrefix(a, "-name"):
			namePat = strings.TrimPrefix(a, "-name")
		case !isFlag(a):
			roots = append(roots, a)
		}
	}
	if len(roots) == 0 {
		roots = []string{"."}
	}
	var nameRe *regexp.Regexp
	if namePat != "" {
		expr := globToRegex(namePat)
		var err error
		nameRe, err = regexp.Compile(expr)
		if err != nil {
			errOut(io, fmt.Sprintf("find: 名称模式错误: %v\n", err))
			return exitCode(1)
		}
	}

	match := func(p string, isDir bool) bool {
		if typeFilter == "f" && isDir {
			return false
		}
		if typeFilter == "d" && !isDir {
			return false
		}
		if nameRe != nil && !nameRe.MatchString(filepath.Base(p)) {
			return false
		}
		return true
	}

	for _, root := range roots {
		var walk func(dir string, d int)
		walk = func(dir string, d int) {
			entries, err := os.ReadDir(io.resolvePath(dir))
			if err != nil {
				return
			}
			for _, e := range entries {
				p := filepath.Join(dir, e.Name())
				if match(p, e.IsDir()) {
					out(io, filepath.ToSlash(p)+"\n")
				}
				if e.IsDir() && (maxDepth < 0 || d+1 < maxDepth) {
					walk(p, d+1)
				}
			}
		}
		walk(root, 0)
	}
	return nil
}

// ---------- 模式辅助 ----------

// globToRegex 把 find -name 的 shell glob 翻译成锚定正则。
// 原来只用 ReplaceAll 把 . 和 * 换掉，导致三类静默错误：
//   - '?' 变成正则量词，'foo?' 匹配不到 foo1
//   - 'c++*' / 'a(b)*' 里未转义的元字符让正则直接编译失败
//   - '[!b]' 没转成 Go 的 '[^b]'，排除语义整个失效
func globToRegex(pat string) string {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pat); i++ {
		c := pat[i]
		switch c {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		case '[':
			j := i + 1
			if j < len(pat) && (pat[j] == '!' || pat[j] == '^') {
				j++
			}
			// 字符类里紧跟开头的 ] 是字面量
			if j < len(pat) && pat[j] == ']' {
				j++
			}
			for j < len(pat) && pat[j] != ']' {
				j++
			}
			if j >= len(pat) {
				// 没有配对的 ]，按字面量处理
				b.WriteString(regexp.QuoteMeta("["))
				break
			}
			body := pat[i+1 : j]
			if strings.HasPrefix(body, "!") {
				body = "^" + body[1:]
			}
			body = strings.ReplaceAll(body, `\`, `\\`)
			b.WriteString("[" + body + "]")
			i = j
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return b.String()
}

// parseSCommand 解析 sed 的 s<delim>pattern<delim>replacement<delim>[flags]。
// 必须按转义规则手工切分：s/a\/b/X/ 里的 \/ 是模式内的字面斜杠，
// 用 strings.Split 会切成 "a\" 和 "b"，正则直接编译失败。
func parseSCommand(rest string, delim byte) (pat, rep, flags string, err error) {
	var parts []string
	var cur strings.Builder
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if c == '\\' && i+1 < len(rest) {
			next := rest[i+1]
			if next == delim {
				// 转义的分隔符：还原成字面量，分隔符在正则里无特殊含义
				cur.WriteByte(delim)
			} else {
				// 其他转义（\. \* 等）原样保留给正则
				cur.WriteByte(c)
				cur.WriteByte(next)
			}
			i++
			continue
		}
		if c == delim {
			parts = append(parts, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	parts = append(parts, cur.String())
	if len(parts) < 2 {
		return "", "", "", fmt.Errorf("s 命令格式不正确")
	}
	pat = parts[0]
	rep = parts[1]
	if len(parts) > 2 {
		flags = parts[2]
	}
	return pat, rep, flags, nil
}
