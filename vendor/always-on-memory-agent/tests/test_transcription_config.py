import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock


def _install_test_stubs():
    if "aiohttp" not in sys.modules:
        aiohttp_module = ModuleType("aiohttp")
        aiohttp_module.web = SimpleNamespace(
            Application=object,
            Request=object,
            json_response=lambda *args, **kwargs: {},
        )
        sys.modules["aiohttp"] = aiohttp_module

    if "openai" not in sys.modules:
        openai_module = ModuleType("openai")

        class PlaceholderOpenAI:
            def __init__(self, *args, **kwargs):
                pass

        openai_module.OpenAI = PlaceholderOpenAI
        sys.modules["openai"] = openai_module


_install_test_stubs()

import agent


TEST_ENV = {
    "MEMORY_OPENAI_API_KEY": "main-key",
    "MEMORY_OPENAI_BASE_URL": "https://main.example/v1",
    "MODEL": "main-model-test",
    "TRANSCRIPTION_OPENAI_API_KEY": "transcription-key",
    "TRANSCRIPTION_OPENAI_BASE_URL": "https://transcription.example/v1",
    "TRANSCRIPTION_MODEL": "transcription-model-test",
}


class FakeTranscriptions:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(text="transcribed text")


class FakeOpenAIClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.audio = SimpleNamespace(transcriptions=FakeTranscriptions())


class FakeOpenAIFactory:
    def __init__(self):
        self.instances = []

    def __call__(self, **kwargs):
        client = FakeOpenAIClient(**kwargs)
        self.instances.append(client)
        return client


class MemoryAgentConfigTests(unittest.TestCase):
    def setUp(self):
        self.factory = FakeOpenAIFactory()
        self.openai_patcher = mock.patch("agent.OpenAI", side_effect=self.factory)
        self.openai_patcher.start()
        self.addCleanup(self.openai_patcher.stop)

    def test_missing_main_base_url_fails_startup(self):
        env = dict(TEST_ENV)
        env.pop("MEMORY_OPENAI_BASE_URL")

        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(
                RuntimeError,
                "Missing MEMORY_OPENAI_BASE_URL environment variable for main OpenAI client",
            ):
                agent.MemoryAgent()

    def test_missing_transcription_api_key_fails_startup(self):
        env = dict(TEST_ENV)
        env.pop("TRANSCRIPTION_OPENAI_API_KEY")

        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(
                RuntimeError,
                "Missing TRANSCRIPTION_OPENAI_API_KEY environment variable for transcription OpenAI client",
            ):
                agent.MemoryAgent()

    def test_memory_agent_builds_separate_clients(self):
        with mock.patch.dict(os.environ, TEST_ENV, clear=True):
            memory_agent = agent.MemoryAgent()

        self.assertEqual(memory_agent.config.main.base_url, TEST_ENV["MEMORY_OPENAI_BASE_URL"])
        self.assertEqual(
            memory_agent.config.transcription.base_url,
            TEST_ENV["TRANSCRIPTION_OPENAI_BASE_URL"],
        )
        self.assertEqual(len(self.factory.instances), 2)
        self.assertEqual(
            self.factory.instances[0].kwargs,
            {
                "api_key": TEST_ENV["MEMORY_OPENAI_API_KEY"],
                "base_url": TEST_ENV["MEMORY_OPENAI_BASE_URL"],
            },
        )
        self.assertEqual(
            self.factory.instances[1].kwargs,
            {
                "api_key": TEST_ENV["TRANSCRIPTION_OPENAI_API_KEY"],
                "base_url": TEST_ENV["TRANSCRIPTION_OPENAI_BASE_URL"],
            },
        )

    def test_transcribe_bytes_uses_dedicated_transcription_client_and_model(self):
        with mock.patch.dict(os.environ, TEST_ENV, clear=True):
            memory_agent = agent.MemoryAgent()

        transcript = memory_agent._transcribe_bytes(b"abc", "clip.wav", "audio/wav")

        self.assertEqual(transcript, "transcribed text")
        self.assertEqual(len(self.factory.instances[0].audio.transcriptions.calls), 0)
        self.assertEqual(len(self.factory.instances[1].audio.transcriptions.calls), 1)
        call = self.factory.instances[1].audio.transcriptions.calls[0]
        self.assertEqual(call["model"], TEST_ENV["TRANSCRIPTION_MODEL"])
        self.assertEqual(call["file"].name, "clip.wav")

    def test_video_preprocess_uses_transcription_client(self):
        with mock.patch.dict(os.environ, TEST_ENV, clear=True):
            memory_agent = agent.MemoryAgent()

        created_dirs = []
        real_mkdtemp = tempfile.mkdtemp

        def fake_mkdtemp(*args, **kwargs):
            path = real_mkdtemp(*args, **kwargs)
            created_dirs.append(Path(path))
            return path

        def fake_run(cmd, check, capture_output):
            output_path = Path(cmd[-1])
            if output_path.suffix == ".wav":
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(b"wav-data")
            else:
                output_path.parent.mkdir(parents=True, exist_ok=True)
                (output_path.parent / "frame_001.jpg").write_bytes(b"frame-data")
            return subprocess.CompletedProcess(cmd, 0)

        with tempfile.TemporaryDirectory() as temp_dir:
            video_path = Path(temp_dir) / "clip.mp4"
            video_path.write_bytes(b"video-data")

            with mock.patch("agent.subprocess.run", side_effect=fake_run):
                with mock.patch("agent.tempfile.mkdtemp", side_effect=fake_mkdtemp):
                    transcript, frames = memory_agent._preprocess_video_sync(video_path)

        self.assertEqual(transcript, "transcribed text")
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].name, "retained_000.jpg")
        self.assertEqual(len(self.factory.instances[0].audio.transcriptions.calls), 0)
        self.assertEqual(len(self.factory.instances[1].audio.transcriptions.calls), 1)
        call = self.factory.instances[1].audio.transcriptions.calls[0]
        self.assertEqual(call["model"], TEST_ENV["TRANSCRIPTION_MODEL"])
        self.assertEqual(call["file"].name, "audio.wav")

        for frame in frames:
            frame.unlink(missing_ok=True)
        for directory in created_dirs:
            shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
