package httpapi

import "testing"

func TestValidPersonalShelfOrder(t *testing.T) {
	for _, test := range []struct {
		input personalShelfOrderInput
		want  bool
	}{
		{personalShelfOrderInput{1, 2, "before"}, true},
		{personalShelfOrderInput{2, 1, "after"}, true},
		{personalShelfOrderInput{1, 1, "before"}, false},
		{personalShelfOrderInput{0, 2, "after"}, false},
		{personalShelfOrderInput{1, -2, "after"}, false},
		{personalShelfOrderInput{1, 2, "earlier"}, false},
		{personalShelfOrderInput{1, 2, ""}, false},
	} {
		if got := validPersonalShelfOrder(test.input); got != test.want {
			t.Fatalf("validPersonalShelfOrder(%+v)=%v, want %v", test.input, got, test.want)
		}
	}
}
