package httpapi

import (
	"reflect"
	"testing"
)

func TestNormalizePersonalShelfBookIDs(t *testing.T) {
	limit := make([]int64, maxPersonalShelfBatchSize)
	for index := range limit {
		limit[index] = int64(index + 1)
	}
	for _, test := range []struct {
		name string
		ids  []int64
		want []int64
		ok   bool
	}{
		{name: "preserves first occurrence order", ids: []int64{9, 3, 9, 2, 3}, want: []int64{9, 3, 2}, ok: true},
		{name: "maximum", ids: limit, want: limit, ok: true},
		{name: "empty", ids: []int64{}},
		{name: "missing"},
		{name: "zero", ids: []int64{1, 0}},
		{name: "negative", ids: []int64{1, -2}},
		{name: "too many", ids: append(append([]int64{}, limit...), 1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, ok := normalizePersonalShelfBookIDs(test.ids)
			if ok != test.ok || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("normalizePersonalShelfBookIDs(%v)=(%v,%v), want=(%v,%v)", test.ids, got, ok, test.want, test.ok)
			}
		})
	}
}
