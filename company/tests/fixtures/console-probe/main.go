package main

import (
	"context"
	"encoding/json"
	"os"

	"github.com/yetone/magpie/internal/nikou"
)

func main() {
	if len(os.Args) != 3 {
		os.Exit(2)
	}
	c, err := nikou.NewConsoleClient(os.Args[1], os.Args[2])
	if err != nil {
		os.Exit(2)
	}
	for _, route := range []string{"hello", "status"} {
		reply := c.Call(context.Background(), "GET", route, nil, nil)
		if err := json.NewEncoder(os.Stdout).Encode(reply); err != nil {
			os.Exit(1)
		}
		if !reply.OK {
			os.Exit(1)
		}
	}
	// 实际跨语言登记，防止双端各自的假服务掩盖字段不一致。
	connection := []byte(`{"requestId":"contract-gateway-register","confirmed":true,"origin":"http://127.0.0.1:3425","agentToken":"magpie-nikou","sessionHeader":"X-Magpie-Session","models":[{"modelRef":"fixture/model","protocol":"openai-responses","reasoning":false,"supportedEfforts":[],"verified":false}]}`)
	for i := 0; i < 2; i++ {
		reply := c.Call(context.Background(), "POST", "v2/runtime/gateway", nil, connection)
		if err := json.NewEncoder(os.Stdout).Encode(reply); err != nil || !reply.OK {
			os.Exit(1)
		}
	}
	reply := c.Call(context.Background(), "GET", "v2/runtime/catalog", nil, nil)
	if err := json.NewEncoder(os.Stdout).Encode(reply); err != nil || !reply.OK {
		os.Exit(1)
	}
	reply = c.Call(context.Background(), "GET", "status", nil, nil)
	if err := json.NewEncoder(os.Stdout).Encode(reply); err != nil || !reply.OK {
		os.Exit(1)
	}
}
