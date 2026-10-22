package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// loadKey reads a hex ed25519 seed from path, creating one if absent.
func loadKey(path string) ed25519.PrivateKey {
	if b, err := os.ReadFile(path); err == nil {
		seed, err := hex.DecodeString(strings.TrimSpace(string(b)))
		if err == nil && len(seed) == ed25519.SeedSize {
			return ed25519.NewKeyFromSeed(seed)
		}
		log.Fatalf("bad key file %s", path)
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := os.WriteFile(path, []byte(hex.EncodeToString(priv.Seed())), 0o600); err != nil {
		log.Fatal(err)
	}
	return priv
}

func main() {
	mode := "log"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	addr := env("LISTEN", ":8080")
	data := env("DATA_DIR", "./data")
	os.MkdirAll(data, 0o700)

	switch mode {
	case "log":
		priv := loadKey(data + "/log.key")
		l, err := OpenLog(data+"/log.jsonl", priv)
		if err != nil {
			log.Fatal(err)
		}
		var ws []string
		for _, u := range strings.Split(env("WITNESS_URLS", ""), ",") {
			if u = strings.TrimSpace(u); u != "" {
				ws = append(ws, u)
			}
		}
		s := &Server{log: l, token: os.Getenv("APPEND_TOKEN"), witnessURL: ws, anchorPath: data + "/anchors.jsonl"}
		if s.token == "" {
			log.Fatal("APPEND_TOKEN must be set")
		}
		d, _ := time.ParseDuration(env("ANCHOR_INTERVAL", "1h"))
		switch env("ANCHOR_MODE", "simulated") {
		case "opentimestamps":
			// Sends only the 32-byte head root to public calendar servers, which anchor it in Bitcoin.
			s.calendars = DefaultCalendars
			if v := os.Getenv("OTS_CALENDARS"); v != "" {
				s.calendars = nil
				for _, u := range strings.Split(v, ",") {
					if u = strings.TrimSpace(u); u != "" {
						s.calendars = append(s.calendars, u)
					}
				}
			}
			ud, _ := time.ParseDuration(env("OTS_UPGRADE_INTERVAL", "30m"))
			fmt.Println("anchoring: opentimestamps via", strings.Join(s.calendars, ", "))
			go s.otsLoop(d, ud)
		case "simulated":
			fmt.Println("anchoring: SIMULATED (local file only; not an external proof)")
			go s.anchorLoop(d)
		default:
			log.Fatal("ANCHOR_MODE must be simulated or opentimestamps")
		}
		fmt.Printf("trustlog log=%s size=%d key=%x\n", addr, l.Size(), priv.Public())
		log.Fatal(http.ListenAndServe(addr, s.Routes()))
	case "witness":
		w := NewWitness(loadKey(data+"/witness.key"), os.Getenv("LOG_URL"), os.Getenv("LOG_KEY"))
		go w.Run(time.Second)
		fmt.Printf("trustlog witness=%s key=%x\n", addr, w.pub())
		log.Fatal(http.ListenAndServe(addr, w.Routes()))
	default:
		log.Fatalf("unknown mode %q (use log|witness)", mode)
	}
}
