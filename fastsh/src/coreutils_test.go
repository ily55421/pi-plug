package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCountStream(t *testing.T) {
	counts, err := countStream(strings.NewReader("中文 abc\n第二行"))
	if err != nil {
		t.Fatal(err)
	}
	want := [4]int{1, 3, 20, 10}
	if counts != want {
		t.Fatalf("countStream() = %v, want %v", counts, want)
	}
}

func TestStreamTailRingBuffer(t *testing.T) {
	for _, tc := range []struct {
		name      string
		input     string
		n         int
		fromStart bool
		want      []string
	}{
		{name: "last lines", input: "a\nb\nc\nd\n", n: 2, want: []string{"c", "d"}},
		{name: "fewer lines", input: "a\nb\n", n: 5, want: []string{"a", "b"}},
		{name: "from line", input: "a\nb\nc\n", n: 2, fromStart: true, want: []string{"b", "c"}},
		{name: "zero", input: "a\nb\n", n: 0, want: []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			if err := streamTail(strings.NewReader(tc.input), tc.n, tc.fromStart, func(line string) { got = append(got, line) }); err != nil {
				t.Fatal(err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("streamTail() returned %d lines, want %d", len(got), len(tc.want))
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("streamTail()[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestForEachLineSupportsLongLines(t *testing.T) {
	line := strings.Repeat("x", (1<<20)+17)
	var got []string
	if err := forEachLine(strings.NewReader(line+"\nend"), func(value string) error {
		got = append(got, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != line || got[1] != "end" {
		t.Fatalf("forEachLine() returned %d lines or changed data", len(got))
	}
}

func TestCopyFileStreamsAndPreservesMode(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "src"), filepath.Join(dir, "dst")
	data := bytes.Repeat([]byte("stream"), 1<<18)
	if err := os.WriteFile(src, data, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(src, dst); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("copied data does not match")
	}
	info, err := os.Stat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %o, want 640", info.Mode().Perm())
	}
}
