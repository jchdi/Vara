
from TikTokLive import TikTokLiveClient
from TikTokLive.events import CommentEvent

active_clients = {}


async def start_tiktok_live(username, session_id, on_comment):
    username = username.strip().lstrip("@")

    if not username:
        raise ValueError("TikTok username is required")

    if session_id in active_clients:
        raise ValueError("Session already has a TikTok connection")

    client = TikTokLiveClient(unique_id=f"@{username}")

    async def handle_comment(event: CommentEvent):
        if event.user is None:
            return

        # Get the commenter's profile picture URL
        avatar_url = None
        avatar = getattr(event.user, "avatar_thumb", None)

        if avatar:
            urls = getattr(avatar, "url_list", None)
            if urls:
                avatar_url = urls[0]

        await on_comment({
            "username": event.user.unique_id,
            "nickname": event.user.nickname,
            "comment": event.comment,
            "avatar_url": avatar_url
        })

    client.add_listener(CommentEvent, handle_comment)

    connection = {
        "username": username,
        "client": client,
        "task": None
    }

    active_clients[session_id] = connection

    try:
        task = await client.start()
        connection["task"] = task

        def cleanup(_):
            if active_clients.get(session_id) is connection:
                active_clients.pop(session_id, None)

        task.add_done_callback(cleanup)

    except Exception:
        active_clients.pop(session_id, None)
        raise

    return {
        "status": "connecting",
        "username": username,
        "session_id": session_id
    }


async def stop_tiktok_live(session_id):
    connection = active_clients.get(session_id)

    if not connection:
        return {"status": "not_connected"}

    await connection["client"].disconnect()

    active_clients.pop(session_id, None)

    return {"status": "disconnected"}
    
