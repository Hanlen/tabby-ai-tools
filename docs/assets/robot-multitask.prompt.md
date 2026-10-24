# README robot animation

Created and enhanced with the built-in `image_gen` tool. The original
1536 × 1024 sprite sheet contained 12 frames arranged in 3 columns and 4 rows.
For version 0.2.3, the original frames were grouped into six square pairs, each
containing two successive frames stacked vertically. Each pair was enhanced
independently while preserving the robot, scene, pose sequence and camera.
The selected outputs are 1254 × 1254 pixels per pair; each half is 1254 × 627.
Downsample each half with Lanczos to the final 1024 × 512 frame size.

`robot-multitask.gif` keeps 12 frames with a shared 256-color median-cut palette,
Floyd–Steinberg dithering, infinite looping, disposal mode 2, and frame durations
`[220, 160, 160, 160, 160, 100, 100, 100, 160, 160, 160, 220]` milliseconds
(1.86 seconds total). `robot-multitask.png` is the full-color static first frame
at the same 1024 × 512 resolution. Both README editions display the artwork at
560 × 280, with the PNG selected for reduced-motion preferences. The GIF is
approximately 3.30 MiB; the PNG is approximately 529 KiB.

The final encoding was performed with Pillow after AI enhancement: crop the two
equal halves, downsample, assemble a 3-column/4-row sheet to calculate one shared
palette, quantize every frame with that palette, and save the timed GIF. Inspect
all frames for clipping, registration drift and loop continuity; decode the final
GIF to verify dimensions, frame count, timing and looping. Keep the full-color
first frame as the reduced-motion fallback.

The terminal windows are decorative illustrations, not screenshots of the plugin.

## High-definition enhancement prompt

Apply this exact prompt to each original square frame pair:

```text
Use case: identity-preserve. Upscale this existing animation frame pair to 1024 x 1024 pixels, exactly double the supplied resolution. Output must be SQUARE. The square contains precisely TWO wide images stacked vertically, ONE COLUMN and TWO ROWS, no gutters, divider or borders. Each half is 1024 x 512. Faithfully enhance the exact supplied pixels: same white robot identity, facial expression and eye shapes in each respective half, dark navy background, proportions, floating terminal windows, exact geometry and placement, keyboard, mug, plant, mouse and books. Preserve every object position for animation registration. Refine clarity and edges without redesigning, adding details, altering the camera, or moving anything. No new text, no letters, no watermark. This is high-fidelity super-resolution of the supplied frame pair for a looping animation. Preserve pose differences between the upper and lower frame.
```

## Original generation prompt

```text
Use case: stylized-concept.
Asset type: animation sprite sheet for a looping GitHub README hero GIF, immediately below the project title "Tabby AI Tools".

Primary request: a very cute little robot busily operating multiple terminal task windows. Make the robot lovable, rounded, and expressive, with a large pearl-white rounded head, dark glass face, large mint glowing eyes, tiny soft pink cheek lights, short rounded body, small hands, and a small antenna. A polished soft 3D / clay illustration, clear silhouettes, charming without clutter. The robot sits at a tiny keyboard in the foreground. Four floating rounded terminal windows fan around it behind and to the sides, showing abstract mint and lavender code lines, a simple chart, and task progress bars. A few tiny completion checkmarks suggest coordinated multitasking. The scene is wide and compact, with a deep navy background suitable for a developer project's README. The mood is focused, cheerful, cozy and playful. No written words, letters, titles, brand logos, watermarks or captions.

CRITICAL OUTPUT FORMAT: ONE PNG sprite sheet with EXACTLY 3 columns and EXACTLY 4 rows of equally sized frames, 12 frames total. Canvas 1536 x 1024 pixels. Every frame is exactly 512 x 256 pixels, a 2:1 wide image. Frames are tiled edge-to-edge with NO gutters, NO borders, NO dividers, NO frame numbers. Every cell shows the SAME COMPLETE SCENE at the SAME CAMERA POSITION, SAME SCALE, SAME character proportions, SAME keyboard location, SAME window positions, SAME background color. Nothing crosses cell edges. Leave a safe empty margin around each scene inside its cell.

Animation is read left-to-right, then top-to-bottom. Draw successive small changes of the same robot typing, with hands alternating over the keyboard, eyes happily glancing across the task windows, and a brief natural blink around frames 6-7. Small progress bars and cursor highlights change between frames. Keep the robot's head, torso and all window geometry registered consistently across all 12 frames, with only tiny intentional movement. The last frame should closely match the first to create a seamless relaxed loop. No camera movement, no scene cuts, no substantial changes in composition. Prioritize coherent animation and an adorable finished illustration.
```
