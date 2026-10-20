package library

import (
	"path/filepath"
	"testing"

	"github.com/yetone/magpie/internal/agent"
)

func TestNikouUsesIndependentLibraryTarget(t *testing.T) {
	sandbox(t)
	t.Setenv("NIKOU_MANAGED_RUNTIME", "1")
	a, err := agent.Find("nikou")
	if err != nil || !a.Detected() {
		t.Fatalf("Nikou 未注册: %v", err)
	}
	target := targetOf(a)
	d := filepath.Join(home(), ".nikou-block", "library")
	if target == nil || target.MCP.Path != filepath.Join(d, "mcp.json") || target.Skills != filepath.Join(d, "skills") {
		t.Fatalf("Nikou 资源必须独立保存: %+v", target)
	}
	found := false
	for _, v := range Targets() {
		if v.Agent.ID == "nikou" {
			found = true
		}
	}
	if !found {
		t.Fatal("资源库未列出 Nikou")
	}
}
