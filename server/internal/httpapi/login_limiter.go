package httpapi

import (
	"sync"
	"time"
)

type loginAttempt struct {
	failures     int
	windowStart  time.Time
	blockedUntil time.Time
}

const maxTrackedLoginKeys = 10_000

type loginLimiter struct {
	mu          sync.Mutex
	attempts    map[string]loginAttempt
	maxFailures int
	window      time.Duration
	blockFor    time.Duration
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{attempts: make(map[string]loginAttempt), maxFailures: 5, window: 15 * time.Minute, blockFor: 15 * time.Minute}
}

func (l *loginLimiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	attempt, exists := l.attempts[key]
	if !exists {
		return true, 0
	}
	if now.Before(attempt.blockedUntil) {
		return false, attempt.blockedUntil.Sub(now)
	}
	if now.Sub(attempt.windowStart) >= l.window {
		delete(l.attempts, key)
	}
	return true, 0
}

func (l *loginLimiter) failure(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	attempt := l.attempts[key]
	if len(l.attempts) >= maxTrackedLoginKeys {
		for candidate, tracked := range l.attempts {
			if !now.Before(tracked.blockedUntil) && now.Sub(tracked.windowStart) >= l.window {
				delete(l.attempts, candidate)
			}
		}
		if len(l.attempts) >= maxTrackedLoginKeys {
			var oldestKey string
			var oldestTime time.Time
			for candidate, tracked := range l.attempts {
				if oldestKey == "" || tracked.windowStart.Before(oldestTime) {
					oldestKey, oldestTime = candidate, tracked.windowStart
				}
			}
			delete(l.attempts, oldestKey)
		}
	}
	if attempt.windowStart.IsZero() || now.Sub(attempt.windowStart) >= l.window {
		attempt = loginAttempt{windowStart: now}
	}
	attempt.failures++
	if attempt.failures >= l.maxFailures {
		attempt.blockedUntil = now.Add(l.blockFor)
	}
	l.attempts[key] = attempt
	return !attempt.blockedUntil.IsZero(), attempt.blockedUntil.Sub(now)
}

func (l *loginLimiter) success(key string) {
	l.mu.Lock()
	delete(l.attempts, key)
	l.mu.Unlock()
}
