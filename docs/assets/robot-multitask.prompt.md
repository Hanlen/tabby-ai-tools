# README robot animation

Created with the built-in `image_gen` tool. The generated 1536 × 1024 sprite
sheet contains 12 frames arranged in 3 columns and 4 rows. Each 512 × 256 frame
is encoded into `robot-multitask.gif` with a shared 256-color palette, an infinite
loop, and a 1.86-second duration. `robot-multitask.png` is its static first frame.

The terminal windows are decorative illustrations, not screenshots of the plugin.

## Generation prompt

```text
Use case: stylized-concept.
Asset type: animation sprite sheet for a looping GitHub README hero GIF, immediately below the project title "Tabby AI Tools".

Primary request: a very cute little robot busily operating multiple terminal task windows. Make the robot lovable, rounded, and expressive, with a large pearl-white rounded head, dark glass face, large mint glowing eyes, tiny soft pink cheek lights, short rounded body, small hands, and a small antenna. A polished soft 3D / clay illustration, clear silhouettes, charming without clutter. The robot sits at a tiny keyboard in the foreground. Four floating rounded terminal windows fan around it behind and to the sides, showing abstract mint and lavender code lines, a simple chart, and task progress bars. A few tiny completion checkmarks suggest coordinated multitasking. The scene is wide and compact, with a deep navy background suitable for a developer project's README. The mood is focused, cheerful, cozy and playful. No written words, letters, titles, brand logos, watermarks or captions.

CRITICAL OUTPUT FORMAT: ONE PNG sprite sheet with EXACTLY 3 columns and EXACTLY 4 rows of equally sized frames, 12 frames total. Canvas 1536 x 1024 pixels. Every frame is exactly 512 x 256 pixels, a 2:1 wide image. Frames are tiled edge-to-edge with NO gutters, NO borders, NO dividers, NO frame numbers. Every cell shows the SAME COMPLETE SCENE at the SAME CAMERA POSITION, SAME SCALE, SAME character proportions, SAME keyboard location, SAME window positions, SAME background color. Nothing crosses cell edges. Leave a safe empty margin around each scene inside its cell.

Animation is read left-to-right, then top-to-bottom. Draw successive small changes of the same robot typing, with hands alternating over the keyboard, eyes happily glancing across the task windows, and a brief natural blink around frames 6-7. Small progress bars and cursor highlights change between frames. Keep the robot's head, torso and all window geometry registered consistently across all 12 frames, with only tiny intentional movement. The last frame should closely match the first to create a seamless relaxed loop. No camera movement, no scene cuts, no substantial changes in composition. Prioritize coherent animation and an adorable finished illustration.
```
