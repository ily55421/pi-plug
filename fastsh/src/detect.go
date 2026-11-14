package main

// detect.go：判断一条命令是否用了 PowerShell 专有语法。
// 原则：宁错杀不错漏 —— 错杀只是回退到 pwsh（慢但正确），
// 漏杀会让命令在 POSIX 下静默产生错误结果。
import "regexp"

var (
	// PowerShell 作用域变量：$env: / ${env: / $using: 等（POSIX 无此语法）
	reEnvScope = regexp.MustCompile(`\$\{?(env|global|script|using|local|private|variable):`)

	// cmdlet：Verb-Noun 形式（PowerShell 专有，POSIX 无连字符命令）
	reCmdlet = regexp.MustCompile(`(?i)\b(get|set|new|remove|select|where|foreach-object|measure|test|import|export|copy|move|out|join|split|format|invoke|add|clear|group|write|compare|convert|tee|start|stop|restart|resolve|search|show|read|update|mount|unmount|enable|disable|lock|unlock|grant|revoke|enter|exit|wait|watch|debug|trace|repair|optimize|install|uninstall|save|restore|backup|limit|select)-[A-Za-z]+\b`)

	// PowerShell 专有参数（POSIX 工具几乎不会用这些名字）
	rePwshParam = regexp.MustCompile(`(?i)(?:^|\s)-(?:ErrorAction|ExecutionPolicy|NonInteractive|NoProfile|Passthru|ErrorVariable|InformationVariable|OutVariable|WarningVariable|OutBuffer|InformationAction|WarningAction)(?:\s|=|$)`)

	// PowerShell 比较运算符
	rePwshOp = regexp.MustCompile(`(?:^|\s)-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|notin|is|isnot|as)(?:\s|$)`)

	// .ps1 脚本
	rePs1 = regexp.MustCompile(`(?i)\.ps1\b`)

	// 数组/哈希字面量
	rePwshArray = regexp.MustCompile(`(?:^|[\s|(])[@]\(`)

	// ForEach-Object / Where-Object 简写
	rePwshBlock = regexp.MustCompile(`(?:^|[\s|(])[%?]\{`)

	// Windows 反斜杠路径：C:\... 或 .\...
	reWinPath = regexp.MustCompile(`[A-Za-z]:\\`)
	reDotSlash = regexp.MustCompile(`(?:^|[\s;&|("'])\.\\`)
)

// looksLikePowerShell 返回 (是否像 PowerShell, 原因)
func looksLikePowerShell(cmd string) (bool, string) {
	switch {
	case reEnvScope.MatchString(cmd):
		return true, "pwsh_env_var"
	case reCmdlet.MatchString(cmd):
		return true, "pwsh_cmdlet"
	case rePwshParam.MatchString(cmd):
		return true, "pwsh_param"
	case rePwshOp.MatchString(cmd):
		return true, "pwsh_operator"
	case rePs1.MatchString(cmd):
		return true, "pwsh_script"
	case rePwshArray.MatchString(cmd):
		return true, "pwsh_array"
	case rePwshBlock.MatchString(cmd):
		return true, "pwsh_block"
	case reWinPath.MatchString(cmd):
		return true, "win_backslash_path"
	case reDotSlash.MatchString(cmd):
		return true, "win_relative_path"
	}
	return false, ""
}
