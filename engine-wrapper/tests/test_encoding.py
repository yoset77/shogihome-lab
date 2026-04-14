import asyncio
import pytest
from unittest.mock import MagicMock
from engine_wrapper import pipe_stream

class MockWriter:
    def __init__(self):
        self.data = b""
        self.closed = False

    def write(self, chunk):
        self.data += chunk

    async def drain(self):
        pass

    def close(self):
        self.closed = True

@pytest.mark.asyncio
async def test_pipe_stream_utf8():
    # "こんにちは" in UTF-8
    utf8_bytes = "こんにちは\n".encode("utf-8")
    reader = asyncio.StreamReader()
    reader.feed_data(utf8_bytes)
    reader.feed_eof()
    
    writer = MockWriter()
    await pipe_stream(reader, writer, "[Test]")
    
    assert writer.data.decode("utf-8") == "こんにちは\n"

@pytest.mark.asyncio
async def test_pipe_stream_cp932():
    # "こんにちは" in CP932 (Shift-JIS)
    cp932_bytes = "こんにちは\n".encode("cp932")
    reader = asyncio.StreamReader()
    reader.feed_data(cp932_bytes)
    reader.feed_eof()
    
    writer = MockWriter()
    await pipe_stream(reader, writer, "[Test]")
    
    # Should be converted to UTF-8
    assert writer.data.decode("utf-8") == "こんにちは\n"

@pytest.mark.asyncio
async def test_pipe_stream_mixed_mojibake():
    # Valid CP932 that is NOT valid UTF-8
    # "日本語" in CP932: b'\x93\xfa\x96{\x8a\xea'
    cp932_bytes = "日本語\n".encode("cp932")
    reader = asyncio.StreamReader()
    reader.feed_data(cp932_bytes)
    reader.feed_eof()
    
    writer = MockWriter()
    await pipe_stream(reader, writer, "[Test]")
    
    assert writer.data.decode("utf-8") == "日本語\n"

@pytest.mark.asyncio
async def test_pipe_stream_invalid_bytes():
    # Completely invalid bytes that cannot be decoded as UTF-8 or CP932
    # Note: CP932 (Shift-JIS) decoder might decode some invalid bytes into Private Use Area (PUA).
    invalid_bytes = b"\xff\xff\n"
    reader = asyncio.StreamReader()
    reader.feed_data(invalid_bytes)
    reader.feed_eof()
    
    writer = MockWriter()
    await pipe_stream(reader, writer, "[Test]")
    
    # Should not crash. The exact replacement char depends on the decoder's implementation.
    decoded = writer.data.decode("utf-8")
    assert len(decoded) > 0
    assert decoded.endswith("\n")
