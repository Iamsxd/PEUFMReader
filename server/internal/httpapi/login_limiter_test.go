package httpapi

import (
	"testing"
	"time"
)

func TestLoginLimiterBlocksRepeatedFailuresAndResetsOnSuccess(t *testing.T) {
	limiter := newLoginLimiter()
	now := time.Now()
	for attempt := 1; attempt <= 4; attempt++ {
		blocked, _ := limiter.failure("client|admin", now)
		if blocked {
			t.Fatalf("blocked too early after %d attempts", attempt)
		}
	}
	blocked, retryAfter := limiter.failure("client|admin", now)
	if !blocked || retryAfter < 14*time.Minute {
		t.Fatalf("expected block, got blocked=%v retry=%s", blocked, retryAfter)
	}
	if allowed, _ := limiter.allow("client|admin", now.Add(time.Minute)); allowed {
		t.Fatal("blocked login was allowed")
	}
	limiter.success("client|admin")
	if allowed, _ := limiter.allow("client|admin", now.Add(time.Minute)); !allowed {
		t.Fatal("successful login did not reset limiter")
	}
}
