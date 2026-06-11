package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var addr = flag.String("addr", "localhost:8080", "http service address")

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Message struct {
	Type string          `json:"type"`
	Room string          `json:"room"`
	Data json.RawMessage `json:"data"`
}

type Room struct {
	peers [2]*websocket.Conn
	mu    sync.Mutex
}

func (r *Room) other(idx int) *websocket.Conn {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.peers[1-idx]
}

type Server struct {
	rooms map[string]*Room
	mu    sync.Mutex
}

func NewServer() *Server {
	return &Server{
		rooms: make(map[string]*Room),
	}
}

func (s *Server) getOrCreateRoom(name string) *Room {
	s.mu.Lock()
	defer s.mu.Unlock()
	room, ok := s.rooms[name]
	if !ok {
		room = &Room{}
		s.rooms[name] = room
	}
	return room
}

func (s *Server) leaveRoom(name string, conn *websocket.Conn, idx int) {
	s.mu.Lock()
	room, ok := s.rooms[name]
	s.mu.Unlock()
	if !ok {
		return
	}

	room.mu.Lock()
	room.peers[idx] = nil
	other := room.peers[1-idx]
	roomFull := room.peers[0] == nil && room.peers[1] == nil
	room.mu.Unlock()

	if other != nil {
		other.WriteJSON(map[string]string{"type": "peer-left"})
	}

	if roomFull {
		s.mu.Lock()
		delete(s.rooms, name)
		s.mu.Unlock()
	}
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	defer conn.Close()

	var (
		currentRoom string
		peerIndex   int
	)

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			log.Printf("read: %v", err)
			if currentRoom != "" {
				s.leaveRoom(currentRoom, conn, peerIndex)
			}
			return
		}

		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("bad message: %v", err)
			continue
		}

		switch msg.Type {
		case "join":
			if currentRoom != "" {
				s.leaveRoom(currentRoom, conn, peerIndex)
			}

			room := s.getOrCreateRoom(msg.Room)
			room.mu.Lock()

			switch {
			case room.peers[0] == nil:
				room.peers[0] = conn
				peerIndex = 0
				conn.WriteJSON(map[string]string{"type": "joined", "peer": "1"})
			case room.peers[1] == nil:
				room.peers[1] = conn
				peerIndex = 1
				conn.WriteJSON(map[string]string{"type": "joined", "peer": "2"})
				room.peers[0].WriteJSON(map[string]string{"type": "peer-joined"})
			default:
				conn.WriteJSON(map[string]string{"type": "error", "message": "room full"})
				room.mu.Unlock()
				continue
			}

			currentRoom = msg.Room
			room.mu.Unlock()

		case "offer", "answer", "ice-candidate":
			if currentRoom == "" {
				conn.WriteJSON(map[string]string{"type": "error", "message": "join a room first"})
				continue
			}

			s.mu.Lock()
			room, ok := s.rooms[currentRoom]
			s.mu.Unlock()
			if !ok {
				continue
			}

			other := room.other(peerIndex)
			if other != nil {
				other.WriteMessage(websocket.TextMessage, raw)
			}

		case "leave":
			if currentRoom != "" {
				s.leaveRoom(currentRoom, conn, peerIndex)
				currentRoom = ""
			}
		}
	}
}

func main() {
	flag.Parse()

	server := NewServer()
	fs := http.FileServer(http.Dir("../"))

	http.Handle("/", fs)
	http.HandleFunc("/ws", server.handleWebSocket)

	log.Printf("server starting on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
