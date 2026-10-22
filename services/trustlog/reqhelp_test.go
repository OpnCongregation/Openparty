package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
)

func newReq(method, url, body string) *http.Request {
	return httptest.NewRequest(method, url, strings.NewReader(body))
}

// statusOf returns the status code of the handler's response.
func statusOf(h http.Handler, req *http.Request) int {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Code
}
