package agent

import (
	"os"
	"path/filepath"
)

// Nikou 自己消费资源，由 Worker 传给执行引擎，不改写引擎的全局配置。
func nikou(home string) *Agent {
	dir := filepath.Join(home, ".nikou-block")
	return &Agent{ID: "nikou", Name: "Nikou", Icon: "nikou", Bin: "nikou-cli", Dir: dir,
		Path: filepath.Join(dir, "library", "mcp.json"),
		detect: func() bool {
			if os.Getenv("NIKOU_MANAGED_RUNTIME") == "1" {
				return true
			}
			return binAt("nikou-cli") != ""
		},
	}
}
