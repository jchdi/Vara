
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from uuid import uuid4

from games.registry import get_games

app = FastAPI(
    title="VARA Backend",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://jchdi.github.io"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Store active game sessions
sessions = {}


@app.get("/")
async def home():
    return {
        "message": "VARA Backend is running!"
    }


@app.get("/health")
async def health():
    return {
        "status": "ok"
    }


# List all registered games
@app.get("/games")
async def list_games():
    return get_games()


# Create a new independent session
@app.post("/sessions")
async def create_session():
    session_id = str(uuid4())

    sessions[session_id] = {
        "players": [],
        "status": "waiting",
        "connections": []
    }

    return {
        "session_id": session_id,
        "status": "created"
    }


# Get session information
@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    if session_id not in sessions:
        return {
            "error": "Session not found"
        }

    session = sessions[session_id]

    return {
        "session_id": session_id,
        "players": session["players"],
        "status": session["status"]
    }


# Real-time communication for each session
@app.websocket("/ws/{session_id}")
async def game_updates(websocket: WebSocket, session_id: str):

    if session_id not in sessions:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    connections = sessions[session_id]["connections"]
    connections.append(websocket)

    try:
        while True:
            message = await websocket.receive_json()

            for connection in connections[:]:
                if connection != websocket:
                    try:
                        await connection.send_json(message)
                    except Exception:
                        if connection in connections:
                            connections.remove(connection)

    except WebSocketDisconnect:
        if websocket in connections:
            connections.remove(websocket)
    
