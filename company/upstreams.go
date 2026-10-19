package company

import _ "embed"

// 构建时固化基线，安装机器无需保留源码或 Git。
//
//go:embed upstreams.lock.json
var UpstreamsLock []byte

//go:embed upstreams.policy.json
var UpstreamsPolicy []byte
