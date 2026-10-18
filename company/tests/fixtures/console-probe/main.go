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
}
