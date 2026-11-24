package main

import (
	"regexp"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

var (
	reEnvScope  = regexp.MustCompile(`(?i)^\$\{?(env|global|script|using|local|private|variable):[a-z_]`)
	reCmdlet    = regexp.MustCompile(`(?i)^(?:get|set|new|remove|select|where|foreach|measure|test|import|export|copy|move|out|join|split|format|invoke|add|clear|group|write|compare|convert|tee|start|stop|restart|resolve|search|show|read|update|mount|unmount|enable|disable|lock|unlock|grant|revoke|enter|exit|wait|watch|debug|trace|repair|optimize|install|uninstall|save|restore|backup|limit)-[a-z]+$`)
	rePwshParam = regexp.MustCompile(`(?i)^-(?:ErrorAction|ExecutionPolicy|NonInteractive|NoProfile|Passthru|ErrorVariable|InformationVariable|OutVariable|WarningVariable|OutBuffer|InformationAction|WarningAction)(?:=|$)`)
	rePwshOp    = regexp.MustCompile(`(?i)^-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|notin|is|isnot|as)$`)
	rePwshArray = regexp.MustCompile(`(?:^|[\s|(])@\(`)
	rePwshBlock = regexp.MustCompile(`(?:^|[\s|(])[%?]\{`)
	reWinPath   = regexp.MustCompile(`^[A-Za-z]:\\`)
)

// literalWord 只读静态单词；不要把带扩展的单词前缀当成完整命令。
func literalWord(w *syntax.Word) (string, bool) {
	var b strings.Builder
	for _, part := range w.Parts {
		switch p := part.(type) {
		case *syntax.Lit:
			if strings.Contains(p.Value, "\\") {
				return "", false
			}
			b.WriteString(p.Value)
		case *syntax.SglQuoted:
			if p.Dollar {
				return "", false
			}
			b.WriteString(p.Value)
		case *syntax.DblQuoted:
			for _, child := range p.Parts {
				lit, ok := child.(*syntax.Lit)
				if !ok || strings.Contains(lit.Value, "\\") {
					return "", false
				}
				b.WriteString(lit.Value)
			}
		default:
			return "", false
		}
	}
	return b.String(), true
}

func powerShellReason(command string, prog *syntax.File, parseErr error) string {
	if parseErr != nil {
		// 解析失败时无论如何都不会执行；这里只补充诊断原因。
		switch {
		case reEnvScope.MatchString(strings.TrimSpace(command)):
			return "pwsh_env_var"
		case rePwshArray.MatchString(command):
			return "pwsh_array"
		case rePwshBlock.MatchString(command):
			return "pwsh_block"
		default:
			return "posix_parse_error"
		}
	}

	reason := ""
	src := func(node syntax.Node) string { return command[node.Pos().Offset():node.End().Offset()] }
	syntax.Walk(prog, func(node syntax.Node) bool {
		if reason != "" {
			return false
		}
		switch n := node.(type) {
		case *syntax.ParamExp:
			if reEnvScope.MatchString(src(n)) || n.Short && reEnvScope.MatchString(command[n.Pos().Offset():]) {
				reason = "pwsh_env_var"
			}
		case *syntax.CallExpr:
			if len(n.Args) == 0 {
				return true
			}
			name, _ := literalWord(n.Args[0])
			for i, arg := range n.Args {
				raw := src(arg)
				switch {
				case i == 0 && strings.HasSuffix(strings.ToLower(strings.Trim(raw, `"'`)), ".ps1"):
					reason = "pwsh_script"
				case i == 0 && reCmdlet.MatchString(raw):
					reason = "pwsh_cmdlet"
				case reWinPath.MatchString(raw):
					reason = "win_backslash_path"
				case strings.HasPrefix(raw, `.\`):
					reason = "win_relative_path"
				case i > 0 && rePwshParam.MatchString(raw):
					reason = "pwsh_param"
				case i > 0 && name != "[" && name != "test" && rePwshOp.MatchString(raw):
					reason = "pwsh_operator"
				}
				if reason != "" {
					break
				}
			}
		}
		return reason == ""
	})
	return reason
}
