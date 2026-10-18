package nikou

import (
	"encoding/json"
	"os"
	"testing"
)

func TestNikouSharedProtocolFixture(t *testing.T) {
	bytes, err := os.ReadFile("../../company/tests/fixtures/nikou-bridge-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures map[string]json.RawMessage
	if err := json.Unmarshal(bytes, &fixtures); err != nil {
		t.Fatal(err)
	}
	for name, raw := range fixtures {
		t.Run(name, func(t *testing.T) {
			var reply Reply
			if err := json.Unmarshal(raw, &reply); err != nil {
				t.Fatal(err)
			}
			if reply.Protocol != Protocol || !safeID.MatchString(reply.RequestID) {
				t.Fatal(string(raw))
			}
			if name == "failure" {
				if reply.OK || reply.Error == nil || reply.Error.Code != "CAPABILITY_UNSUPPORTED" {
					t.Fatal(string(raw))
				}
				return
			}
			if !reply.OK || reply.Data == nil || reply.Error != nil {
				t.Fatal(string(raw))
			}
		})
	}
	var accounts struct {
		Data struct {
			Profiles []struct {
				ID  string     `json:"id"`
				Ref AccountRef `json:"ref"`
			} `json:"profiles"`
		} `json:"data"`
	}
	if err := json.Unmarshal(fixtures["accounts"], &accounts); err != nil {
		t.Fatal(err)
	}
	for _, p := range accounts.Data.Profiles {
		ref, err := DecodeAccountRef(p.ID)
		if err != nil || ref != p.Ref {
			t.Fatal("双端账号引用契约不符")
		}
	}
}
