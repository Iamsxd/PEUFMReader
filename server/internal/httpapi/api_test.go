package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestValidPosition(t *testing.T) {
	tests := []struct {
		name  string
		value json.RawMessage
		valid bool
	}{
		{name: "EPUB", value: json.RawMessage(`{"cfi":"epubcfi(/6/2)","progression":0.5}`), valid: true},
		{name: "PDF", value: json.RawMessage(`{"pageIndex":4,"yRatio":0.2}`), valid: true},
		{name: "array", value: json.RawMessage(`[]`), valid: false},
		{name: "null", value: json.RawMessage(`null`), valid: false},
		{name: "invalid", value: json.RawMessage(`{`), valid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := validPosition(test.value); got != test.valid {
				t.Fatalf("validPosition(%s)=%v, want %v", test.value, got, test.valid)
			}
		})
	}
}

func TestParseIDRejectsInvalidValues(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "abc"} {
		recorder := httptest.NewRecorder()
		if _, ok := parseID(recorder, value); ok {
			t.Fatalf("parseID accepted %q", value)
		}
		if recorder.Code != 400 {
			t.Fatalf("parseID(%q) status=%d", value, recorder.Code)
		}
	}
}
