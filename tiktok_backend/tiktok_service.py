from TikTokLive import TikTokLiveClient
from TikTokLive.events import CommentEvent, GiftEvent

active_clients = {}


def _value(obj, *names):
    """Return the first non-empty attribute from a TikTokLive model."""
    for name in names:
        try:
            value = getattr(obj, name, None)
        except Exception:
            value = None

        if value is not None and value != "":
            return value

    return None


async def start_tiktok_live(username, session_id, on_comment, on_gift=None):
    username = username.strip().lstrip("@")

    if not username:
        raise ValueError("TikTok username is required")

    if session_id in active_clients:
        raise ValueError("Session already has a TikTok connection")

    client = TikTokLiveClient(unique_id=f"@{username}")

    async def handle_comment(event: CommentEvent):
        user = event.user

        if user is None:
            return

        avatar_url = None

        try:
            avatar = user.avatar_thumb

            if avatar:
                urls = getattr(avatar, "url_list", None)

                if urls and len(urls) > 0:
                    avatar_url = urls[0]

        except Exception as error:
            print(f"[VARA AVATAR ERROR] {error}")

        print(
            f"[VARA AVATAR DEBUG] "
            f"user={user.unique_id}, "
            f"avatar_url={avatar_url}"
        )

        await on_comment({
            "username": user.unique_id,
            "nickname": user.nickname,
            "comment": event.comment,
            "avatar_url": avatar_url,
        })

    async def handle_gift(event: GiftEvent):
        if on_gift is None:
            return

        user = getattr(event, "user", None)
        gift = getattr(event, "gift", None)

        if user is None or gift is None:
            return

        # Ignore intermediate events from streakable gifts.
        if bool(_value(event, "streaking")):
            return

        # Use the same TikTok username used when the player joined by comment.
        unique_id = _value(user, "unique_id", "uniqueId", "username")
        sender_id = str(unique_id or _value(user, "id") or "").strip()

        if not sender_id:
            return

        gift_id = _value(event, "gift_id", "giftId")

        if gift_id is None:
            gift_id = _value(gift, "id", "gift_id", "giftId")

        if gift_id is None:
            extended = _value(gift, "extended_gift", "extendedGift")

            if extended is not None:
                gift_id = _value(extended, "id", "gift_id", "giftId")

        gift_name = _value(gift, "name", "gift_name", "giftName")
        gift_type = _value(gift, "type", "gift_type", "giftType")
        nickname = _value(user, "nickname", "display_id") or sender_id

        await on_gift({
            "type": "gift",
            "userId": sender_id,
            "uniqueId": sender_id,
            "username": sender_id,
            "nickname": str(nickname),
            "giftId": str(gift_id) if gift_id is not None else "",
            "giftName": str(gift_name or ""),
            "giftType": str(gift_type) if gift_type is not None else "",
            "repeatCount": _value(event, "repeat_count", "repeatCount"),
            "repeatEnd": _value(event, "repeat_end", "repeatEnd"),
        })

    client.add_listener(CommentEvent, handle_comment)
    client.add_listener(GiftEvent, handle_gift)

    connection = {
        "username": username,
        "client": client,
        "task": None,
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
        "session_id": session_id,
    }


async def stop_tiktok_live(session_id):
    connection = active_clients.get(session_id)

    if not connection:
        return {"status": "not_connected"}

    await connection["client"].disconnect()

    active_clients.pop(session_id, None)

    return {"status": "disconnected"}
    
