
import asyncio
from TikTokLive import TikTokLiveClient
from TikTokLive.events import CommentEvent

# Active TikTok LIVE connections
active_clients = {}


async def start_tiktok_live(username: str, session_id: str, on_comment):
    username = username.strip().lstrip("@")

    if not username:
        raise ValueError("TikTok username is required")

    if session_id in active_clients:
        raise ValueError("This session already has a TikTok connection")

    client = TikTokLiveClient(unique_id=f"@{username}")

    @client.on(CommentEvent)
    async def on_comment_event(event: CommentEvent):
        await on_comment({
            "username": event.user.nickname,
            "unique_id": event.user.unique_id,
            "comment": event.comment
        })

    active_clients[session_id] = client

    try:
        await client.start()
    finally:
        active_clients.pop(session_id, None)


async def stop_tiktok_live(session_id: str):
    client = active_clients.get(session_id)

    if client:
        await client.disconnect()
        active_clients.pop(session_id, None)
      
