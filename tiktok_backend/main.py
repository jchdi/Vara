import os
from uuid import uuid4
from typing import Any

import jwt
from jwt import PyJWKClient
from jwt.exceptions import InvalidTokenError, PyJWKClientError

from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    HTTPException,
    Depends,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from games.registry import get_games
from tiktok_service import start_tiktok_live, stop_tiktok_live


SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_JWKS_URL = os.getenv(
    "SUPABASE_JWKS_URL",
    f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"
    if SUPABASE_URL else "",
)
SUPABASE_ISSUER = f"{SUPABASE_URL}/auth/v1" if SUPABASE_URL else ""

_jwks_client = PyJWKClient(SUPABASE_JWKS_URL) if SUPABASE_JWKS_URL else None
_bearer = HTTPBearer(auto_error=False)


app = FastAPI(title="VARA Backend", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://jchdi.github.io"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# Active game sessions
sessions: dict[str, dict[str, Any]] = {}


class TikTokStartRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)


def verify_access_token(token: str) -> dict[str, Any]:

    if not _jwks_client or not SUPABASE_ISSUER:
        raise HTTPException(
            status_code=503,
            detail="Supabase JWT verification is not configured.",
        )

    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)

        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            audience="authenticated",
            issuer=SUPABASE_ISSUER,
            options={"require": ["exp", "sub"]},
        )

        if not isinstance(claims.get("sub"), str) or not claims["sub"]:
            raise InvalidTokenError("Missing subject")

        return claims

    except (InvalidTokenError, PyJWKClientError, ValueError):
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired Supabase access token.",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
):

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="A Supabase access token is required.",
        )

    return verify_access_token(credentials.credentials)


def get_owned_session(session_id: str, user_id: str):

    session = sessions.get(session_id)

    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    if session["owner_id"] != user_id:
        raise HTTPException(
            status_code=403,
            detail="You do not own this session.",
        )

    return session


async def send_to_session(session_id: str, message: dict):

    session = sessions.get(session_id)

    if session is None:
        return

    for connection in list(session["connections"]):
        try:
            await connection.send_json(message)

        except Exception:
            if connection in session["connections"]:
                session["connections"].remove(connection)


@app.get("/")
async def home():
    return {"message": "VARA Backend is running!"}


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/games")
async def list_games():
    return get_games()


@app.post("/sessions")
async def create_session(
    user: dict = Depends(get_current_user),
):

    session_id = str(uuid4())

    sessions[session_id] = {
        "owner_id": user["sub"],
        "players": [],
        "status": "waiting",
        "connections": [],
        "tiktok_username": None,
    }

    return {
        "session_id": session_id,
        "status": "created",
    }


@app.get("/sessions/{session_id}")
async def get_session(
    session_id: str,
    user: dict = Depends(get_current_user),
):

    session = get_owned_session(session_id, user["sub"])

    return {
        "session_id": session_id,
        "players": session["players"],
        "status": session["status"],
        "tiktok_username": session["tiktok_username"],
    }


@app.post("/sessions/{session_id}/tiktok/start")
async def start_session_tiktok(
    session_id: str,
    body: TikTokStartRequest,
    user: dict = Depends(get_current_user),
):

    session = get_owned_session(session_id, user["sub"])

    async def on_comment(comment: dict):

        await send_to_session(
            session_id,
            {
                "type": "tiktok_comment",
                "data": comment,
            },
        )

    try:

        result = await start_tiktok_live(
            username=body.username,
            session_id=session_id,
            on_comment=on_comment,
        )

        session["tiktok_username"] = result["username"]

        return result

    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not start the TikTok LIVE connection.",
        ) from exc


@app.post("/sessions/{session_id}/tiktok/stop")
async def stop_session_tiktok(
    session_id: str,
    user: dict = Depends(get_current_user),
):

    session = get_owned_session(session_id, user["sub"])

    result = await stop_tiktok_live(session_id)

    session["tiktok_username"] = None

    return result


@app.websocket("/ws/{session_id}")
async def game_updates(websocket: WebSocket, session_id: str):

    await websocket.accept()

    session = sessions.get(session_id)

    if session is None:
        await websocket.close(
            code=1008,
            reason="Session not found",
        )
        return

    try:

        auth_message = await websocket.receive_json()

        if (
            not isinstance(auth_message, dict)
            or auth_message.get("type") != "auth"
        ):
            await websocket.close(
                code=1008,
                reason="Authentication required",
            )
            return

        token = auth_message.get("access_token")

        if not isinstance(token, str) or not token:
            await websocket.close(
                code=1008,
                reason="Invalid authentication",
            )
            return

        try:
            claims = verify_access_token(token)

        except HTTPException:
            await websocket.close(
                code=1008,
                reason="Invalid or expired token",
            )
            return

        if claims["sub"] != session["owner_id"]:
            await websocket.close(
                code=1008,
                reason="Not a session member",
            )
            return

        session["connections"].append(websocket)

        await websocket.send_json({
            "type": "authenticated",
            "session_id": session_id,
        })

        while True:

            message = await websocket.receive_json()

            if not isinstance(message, dict):
                continue

            if message.get("type") == "auth":
                continue

            for connection in list(session["connections"]):

                if connection is websocket:
                    continue

                try:
                    await connection.send_json(message)

                except Exception:
                    if connection in session["connections"]:
                        session["connections"].remove(connection)

    except WebSocketDisconnect:
        pass

    except Exception:
        try:
            await websocket.close(
                code=1011,
                reason="WebSocket error",
            )
        except Exception:
            pass

    finally:

        current = sessions.get(session_id)

        if current and websocket in current["connections"]:
            current["connections"].remove(websocket)
