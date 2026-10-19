package library

import (
	"fmt"
	"path/filepath"
	"strings"
)

// ConfigureCompanyHST 沿用资源库的分发与备份，避免初始化另写客户端文件。
func ConfigureCompanyHST() (*Result, error) {
	return change(func(l *Library) error {
		var found *Server
		for _, s := range l.MCP {
			matches := s.Name == "hst" || strings.TrimSuffix(filepath.Base(s.Command), ".cmd") == "hst-mcp"
			for _, arg := range s.Args {
				matches = matches || strings.Contains(filepath.ToSlash(arg), "/hst-mcp/")
			}
			if !matches {
				continue
			}
			if found != nil {
				return fmt.Errorf("发现多个华盛通 MCP 配置，请先在资源库确认保留项")
			}
			found = s
		}
		if found == nil {
			found = &Server{Name: "hst"}
			for _, target := range Targets() {
				if target.Agent.ID == "codex" || target.Agent.ID == "claude" || target.Agent.ID == "kiro" {
					found.Agents = append(found.Agents, target.Agent.ID)
				}
			}
			l.MCP = append(l.MCP, found)
		}
		// 保留原分配范围、环境和禁用工具，仅替换历史的 node + 源码入口。
		found.Transport, found.Command, found.Args = "stdio", "hst-mcp", nil
		return nil
	})
}
