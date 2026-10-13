package main

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"path"
	"strings"
)

// webHandler serves the phone page and console from the embedded build of
// the web app. Text files are gzipped once at startup, which shrinks a
// phone's first load from about 80 KB to about 30 KB.
func webHandler() http.Handler {
	dist, err := fs.Sub(webFiles, "web/dist")
	if err != nil {
		log.Fatal(err)
	}
	gz := map[string][]byte{}
	fs.WalkDir(dist, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !compressible(p) {
			return err
		}
		data, err := fs.ReadFile(dist, p)
		if err != nil {
			return err
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		zw.Write(data)
		zw.Close()
		gz["/"+p] = buf.Bytes()
		return nil
	})
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable") // names change with content
		} else {
			w.Header().Set("Cache-Control", "no-store")
		}
		name := r.URL.Path
		if name == "/" {
			name = "/index.html"
		}
		if body, ok := gz[name]; ok && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", mime.TypeByExtension(path.Ext(name)))
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
			w.Write(body)
			return
		}
		files.ServeHTTP(w, r)
	})
}

func compressible(p string) bool {
	switch path.Ext(p) {
	case ".html", ".js", ".css", ".svg", ".json":
		return true
	}
	return false
}
