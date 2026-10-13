// Silent Disco for Mac: captures audio on this Mac (no BlackHole) and streams
// it to phones on the same Wi-Fi with one shared Opus encoder. The DJ console
// runs in a native window; -nowindow runs it in Terminal instead.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"time"

	"github.com/mdp/qrterminal/v3"
)

//go:embed all:web
var webFiles embed.FS

func main() {
	port := flag.Int("port", 8080, "port phones connect to")
	name := flag.String("name", "", "party name shown to listeners")
	kbps := flag.Int("kbps", 0, "audio quality in kbit/s (64–256)")
	app := flag.String("app", "", "start with this app (part of its name), e.g. rekordbox")
	input := flag.String("input", "", "start with this audio input (part of its name), e.g. Mixtour")
	list := flag.Bool("list", false, "list the audio sources and exit")
	tone := flag.Bool("tone", false, "start with a test tone")
	noWindow := flag.Bool("nowindow", false, "run in Terminal without the app window")
	flag.Parse()

	if *list {
		printSources(listSources())
		return
	}

	file := settingsPath()
	settings := loadSettings(file)
	if *name != "" {
		settings.Name = *name
	}
	if *kbps != 0 {
		settings.Kbps = clampKbps(*kbps)
	}

	prefer := ""
	switch {
	case *tone:
		prefer = KindTone
	case *app != "" || *input != "":
		kind, q := KindApp, *app
		if *input != "" {
			kind, q = KindInput, *input
		}
		s, ok := matchSource(listSources(), kind, q)
		if !ok {
			fmt.Printf("Nothing matches %q right now. These are available:\n\n", q)
			printSources(listSources())
			os.Exit(1)
		}
		prefer = s.ID
	}

	engine, api, mux, err := newStation(settings, file)
	if err != nil {
		log.Fatal(err)
	}
	ln, actualPort, err := listenFrom(*port)
	if err != nil {
		log.Fatal(err)
	}
	engine.Port = actualPort
	go http.Serve(ln, mux)

	if windowSupported && !*noWindow {
		// The DJ goes live from the window when ready.
		engine.Start(prefer, false)
		engine.OnChange = func() { updateMenu(engine) }
		go func() {
			for range time.Tick(time.Second) {
				updateMenu(engine) // listener counts change without a state change
			}
		}()
		runWindow(engine, api.consoleURL(actualPort))
		return
	}

	engine.Start(prefer, true)
	defer engine.Stop()
	printBanner(actualPort, engine.State().Source.Label)
	fmt.Printf("  DJ console (this computer only): %s\n\n", api.consoleURL(actualPort))
	go statusLine(engine)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	<-stop
	fmt.Println("\nStopping.")
}

// newStation wires the hub, the WebRTC broadcaster, the encoder and the
// engine together, with the phone page and the console API on one mux.
func newStation(settings Settings, file string) (*Engine, *consoleAPI, *http.ServeMux, error) {
	hub := NewHub(Meta{Name: settings.Name, Visual: settings.Visual})
	bc, err := NewBroadcaster(hub, settings.Kbps)
	if err != nil {
		return nil, nil, nil, err
	}
	hub.OnJoin = bc.Join
	hub.OnLeave = bc.Leave
	hub.OnActive = bc.Active
	hub.OnAnswer = bc.Answer
	hub.OnCandidate = bc.Candidate

	var engine *Engine
	enc, err := NewEncoder(settings.Kbps, func(f []byte) { engine.writeFrame(f) })
	if err != nil {
		return nil, nil, nil, err
	}
	engine = NewEngine(hub, bc, enc, settings, file)
	api := newConsoleAPI(engine)

	mux := http.NewServeMux()
	mux.Handle("/", webHandler())
	mux.HandleFunc("/events", hub.ServeEvents)
	mux.HandleFunc("/signal", hub.ServeSignal)
	api.register(mux)
	return engine, api, mux, nil
}

var lastMenu string

// updateMenu refreshes the menu bar's status line.
func updateMenu(e *Engine) {
	live := e.Live()
	n := e.bc.connected()
	text := fmt.Sprintf("Off air · %s", plural(n, "phone", "phones")+" connected")
	if live {
		text = fmt.Sprintf("● Live · %s listening", plural(n, "phone", "phones"))
	}
	key := fmt.Sprint(text, live)
	if key == lastMenu {
		return
	}
	lastMenu = key
	setMenuStatus(text, live)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

func printSources(list []SourceInfo) {
	heading := ""
	for _, s := range list {
		h := map[string]string{KindSystem: "Whole Mac", KindApp: "Apps (DJ software first)", KindInput: "Audio inputs", KindTone: "Testing"}[s.Kind]
		if h != heading {
			heading = h
			fmt.Printf("\n  %s\n", h)
		}
		mark := "  "
		if s.Playing {
			mark = "▶ "
		}
		detail := ""
		if s.Detail != "" {
			detail = "  (" + s.Detail + ")"
		}
		fmt.Printf("    %s%s%s\n", mark, s.Label, detail)
	}
	fmt.Println("\n  Start with one using -app <name> or -input <name>, or pick in the app window.")
}

// listenFrom takes the requested port, or the next free one if it's busy.
func listenFrom(port int) (net.Listener, int, error) {
	for p := port; p < port+20; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", p))
		if err == nil {
			if p != port {
				fmt.Printf("  Port %d is busy, using %d instead.\n", port, p)
			}
			return ln, p, nil
		}
	}
	return nil, 0, fmt.Errorf("no free port between %d and %d", port, port+19)
}

// webHandler serves the phone page from the embedded build of the web app.
func webHandler() http.Handler {
	dist, err := fs.Sub(webFiles, "web/dist")
	if err != nil {
		log.Fatal(err)
	}
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/host" || r.URL.Path == "/host.html":
			http.Error(w, "The DJ controls live in the Silent Disco app on this Mac.", http.StatusNotFound)
			return
		case strings.HasPrefix(r.URL.Path, "/assets/"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		default:
			w.Header().Set("Cache-Control", "no-store")
		}
		files.ServeHTTP(w, r)
	})
}

// lanAddresses lists this machine's IPv4 addresses, Wi-Fi/Ethernet first.
func lanAddresses() []string {
	type addr struct {
		ip    string
		score int
	}
	var found []addr
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.To4() == nil {
				continue
			}
			score := 10
			if strings.HasPrefix(ifc.Name, "en") {
				score = 0
			}
			if !ipnet.IP.IsPrivate() {
				score += 5
			}
			found = append(found, addr{ipnet.IP.String(), score})
		}
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].score < found[j].score })
	out := make([]string, len(found))
	for i, a := range found {
		out[i] = a.ip
	}
	return out
}

func printBanner(port int, source string) {
	addrs := lanAddresses()
	fmt.Println("\n  🎧 Silent Disco")
	fmt.Printf("  Streaming: %s\n\n", source)
	if len(addrs) == 0 {
		fmt.Println("  No Wi-Fi address found. Connect to Wi-Fi so phones can reach you.")
		return
	}
	url := fmt.Sprintf("http://%s:%d/", addrs[0], port)
	qrterminal.GenerateWithConfig(url, qrterminal.Config{
		Level:          qrterminal.M,
		Writer:         os.Stdout,
		HalfBlocks:     true,
		BlackChar:      qrterminal.BLACK_BLACK,
		WhiteChar:      qrterminal.WHITE_WHITE,
		BlackWhiteChar: qrterminal.BLACK_WHITE,
		WhiteBlackChar: qrterminal.WHITE_BLACK,
		QuietZone:      2,
	})
	fmt.Printf("\n  Listeners scan the code or open %s\n", url)
	for _, a := range addrs[1:] {
		fmt.Printf("  (also reachable at http://%s:%d/)\n", a, port)
	}
	fmt.Print("  Press Ctrl+C to stop.\n\n")
}

// statusLine keeps one live line at the bottom: listeners and audio level.
func statusLine(e *Engine) {
	warned := false
	for range time.Tick(250 * time.Millisecond) {
		bars := min(int(e.Level()*20), 20)
		meter := strings.Repeat("▮", bars) + strings.Repeat("·", 20-bars)
		st := e.State()
		// A process tap without permission delivers pure silence rather than
		// an error, so explain once, clearly, if nothing arrives.
		if st.Silent && !warned && st.Source.Kind != KindTone {
			fmt.Print("\r\033[K  No sound is coming in yet. If music is playing, macOS is probably blocking\n" +
				"  the recording: allow Terminal under System Settings → Privacy & Security →\n" +
				"  Screen & System Audio Recording, then restart Silent Disco.\n\n")
		}
		warned = st.Silent
		hint := ""
		switch {
		case st.Status == StatusWaiting:
			hint = "  (waiting for " + st.Source.Label + ")"
		case st.Status == StatusError:
			hint = "  (" + st.Error + ")"
		case st.Silent:
			hint = "  (silent)"
		}
		fmt.Printf("\r\033[K  ● LIVE  phones streaming: %d (page open: %d)  level %s%s", e.bc.connected(), e.hub.Count(), meter, hint)
	}
}
