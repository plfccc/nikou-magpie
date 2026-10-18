package nikou

import (
	"crypto/rand"
	"encoding/hex"
)

const Protocol = 1

type BridgeError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type Reply struct {
	Protocol  int          `json:"protocol"`
	RequestID string       `json:"requestId"`
	OK        bool         `json:"ok"`
	Data      any          `json:"data,omitempty"`
	Error     *BridgeError `json:"error,omitempty"`
}

type Hello struct {
	Service        string          `json:"service"`
	Protocol       int             `json:"protocol"`
	PackageVersion string          `json:"packageVersion"`
	InstanceID     string          `json:"instanceId"`
	Capabilities   map[string]bool `json:"capabilities"`
}

func Failure(id, code, message string, retryable bool) Reply {
	return Reply{Protocol: Protocol, RequestID: id, Error: &BridgeError{Code: code, Message: message, Retryable: retryable}}
}

func Success(id string, data any) Reply {
	return Reply{Protocol: Protocol, RequestID: id, OK: true, Data: data}
}

func requestID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}
