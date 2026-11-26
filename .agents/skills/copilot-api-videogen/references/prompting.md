# Video Prompting Principles

## Core structure

Describe motion and time progression, not just a static frame:

1. **Subject & initial state** — who/what is in frame and where they start
2. **Concrete motion beats** — physical actions sequenced naturally over the clip duration (avoid cramming too many scene cuts into a 5-second clip)
3. **Camera choreography** — locked tripod, slow dolly-in, gentle pan left, low tracking shot, handheld close-up
4. **Setting, lighting & atmosphere** — environment, time of day, weather, lens depth of field, surface textures
5. **Audio & dialogue (when enabled)** — ambient soundscape, sound effects, or quoted spoken dialogue (`She says: "..."`)
6. **Continuity constraints** — keep subject identity, clothing, and camera framing steady; no subtitles, watermarks, or abrupt cuts unless requested

## Pacing by duration

- **3-5 seconds:** single smooth motion beat + one subtle camera movement (ideal for hero loops, product turntables, image-to-video)
- **6-10 seconds:** two linked beats or a clear start-to-finish transition
- **11-15 seconds:** short narrative sequence or dialogue exchange with distinct beginning, middle, and settle

## Mode-specific tips

- **Image-to-video (`--image`):** Focus the prompt on *what moves* and *how the camera moves* rather than re-describing static objects already visible in the image.
- **First + last frame (`--image` + `--last-frame`):** Describe the transition motion and camera behavior bridging the start and end states; pass the same image for both to produce a seamless loop.
- **Reference-to-video (`--ref-image`):**
  - Reference images by 0-based index: `<IMAGE_0>`, `<IMAGE_1>`, ...
  - If `--image` is also supplied, `--image` occupies `<IMAGE_0>` and `--ref-image` inputs start at `<IMAGE_1>`.
  - Give each reference image one clear role (character, outfit, environment, prop) and keep the cast small for stronger consistency.

## Draft-then-final workflow

1. Validate composition and motion with `--duration 4` or `5` and `--resolution 720p` (or `480p`).
2. Once the motion and framing work, render the final clip at `--resolution 1080p` (for T2V / I2V) and target duration.
