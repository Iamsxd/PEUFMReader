package httpapi

import (
	"fmt"
	"syscall"
)

type diskUsage struct {
	TotalBytes     uint64
	AvailableBytes uint64
}

func readDiskUsage(path string) (diskUsage, error) {
	var info syscall.Statfs_t
	if err := syscall.Statfs(path, &info); err != nil {
		return diskUsage{}, fmt.Errorf("stat filesystem: %w", err)
	}
	blockSize := uint64(info.Bsize)
	return diskUsage{
		TotalBytes:     info.Blocks * blockSize,
		AvailableBytes: info.Bavail * blockSize,
	}, nil
}
