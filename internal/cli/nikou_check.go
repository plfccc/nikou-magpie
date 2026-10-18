package cli

import (
	"encoding/json"
	"io"
)

func nikouSelfCheck(output io.Writer) error {
	if err := nikouAssetsCheck(); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"ok": true, "protocol": 1, "component": "magpie", "version": version})
}
