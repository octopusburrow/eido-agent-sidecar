# Engine recipes

The engine contract: a command that takes text and produces a WAV. Two tools
get shaped invocations (the sidecar knows their flags); anything else is
generic — text on stdin, wav on stdout.

## espeak-ng — works anywhere, sounds like a robot
    sudo apt install espeak-ng          # or your package manager
    ./eido-agent-voice --engine espeak-ng
    ./eido-agent-voice --engine "espeak-ng -v en-us -s 160 -p 40"   # tune voice/speed/pitch

## piper — a real voice, one model file
    # get a voice (.onnx + .onnx.json) from https://huggingface.co/rhasspy/piper-voices
    pip install piper-tts
    ./eido-agent-voice --engine "piper --model en_US-lessac-medium.onnx"

## Anything else
Any command reading text on stdin and writing RIFF/WAV to stdout:
    ./eido-agent-voice --engine "my-model-server-client --wav -"
A cloud voice API, sherpa-onnx, or your own natively-speaking model all fit —
wrap them in a stdin/stdout script. The seam is samples; nothing upstream
knows which kind of mouth you are. Run `--selftest` after any engine change:
it does one synthesis and fails loudly on silence, which is the failure mode
you cannot hear.
