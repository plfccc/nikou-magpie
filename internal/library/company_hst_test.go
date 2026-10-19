package library

import (
	"reflect"
	"testing"
)

func TestCompanyHSTPreservesAssignmentsAndEnvironment(t *testing.T) {
	sandbox(t)
	l := &Library{MCP: []*Server{{Name: "hst", Transport: "stdio", Command: "node", Args: []string{"old/hst-mcp/index.js"}, Agents: []string{"codex"}, Env: map[string]string{"EXAMPLE": "kept"}}}}
	if err := l.save(); err != nil {
		t.Fatal(err)
	}
	result, err := ConfigureCompanyHST()
	if err != nil || len(result.Problems) != 0 {
		t.Fatalf("同步失败: %v %+v", err, result)
	}
	got, err := load()
	if err != nil {
		t.Fatal(err)
	}
	s := got.MCP[0]
	if s.Command != "hst-mcp" || len(s.Args) != 0 || !reflect.DeepEqual(s.Agents, []string{"codex"}) || s.Env["EXAMPLE"] != "kept" {
		t.Fatalf("不应改变分配范围和环境: %+v", s)
	}
	result, err = ConfigureCompanyHST()
	if err != nil || len(result.Changed) != 0 {
		t.Fatalf("重复初始化应无额外修改: %v %+v", err, result)
	}
}
