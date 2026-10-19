package cli

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/yetone/magpie/internal/library"
)

func nikouHSTSync(args []string) error {
	if len(args) != 1 || args[0] != "--json" {
		return fmt.Errorf("华盛通 MCP 同步需要 --json")
	}
	result, err := library.ConfigureCompanyHST()
	if err != nil {
		return err
	}
	if len(result.Problems) > 0 {
		return fmt.Errorf("华盛通 MCP 分发存在问题，请在资源库检查")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"synced": true, "changed": result.Changed})
}
