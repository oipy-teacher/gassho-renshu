このフォルダのピアノ音（*.m4a）について
=====================================

音源:       Salamander Grand Piano（Yamaha C5）
作者:       Alexander Holm
ライセンス: Creative Commons Attribution 3.0（CC BY 3.0）
            https://creativecommons.org/licenses/by/3.0/
使った版:   SalamanderGrandPiano-V3+20200602.sf2（FreePats プロジェクトが SF2 形式にまとめたもの）
            https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html

作り方（CC BY の「変更点の表示」として）:
- SF2 の録音点（A0 から短3度おきの 30 鍵）を、強弱 3 段（p=40 / mf=75 / f=110）で 1 音ずつ鳴らし、
  fluidsynth 2.6.1（ゲイン 0.6・48kHz・リバーブ／コーラスなし）で書き出した
- note-on の瞬間から、音が十分に減衰する所（または鍵を押し続けた 4〜14 秒）までを切り出し、最後の 50ms をなめらかに消した
- AAC（m4a・144kbps・ステレオ）にした
- アプリは、読み込み時に AAC の先頭の待ち時間（無音）を取り除き、いちばん近い録音を最大 ±1 半音ずらして鳴らす。
  鍵を離したあとの減り方は、鍵ごとに SF2 から実測したカーブをそのまま当て、ごく控えめな部屋の響き（リバーブ）を足している。
  全体の音量は一律に +11dB 持ち上げている（iPad のスピーカー向け・音色は変わらない）
- 作り直すスクリプト: tmp/gassho/piano/extract_samples.mjs（このアプリのフォルダの外）

以下は SF2 に同梱されていた README の原文（個人の連絡先のメールアドレスだけ伏せた）:
------------------------------------------------------------
Salamander Grand Piano (FreePats)
---------------------------------

Version v3+20200602 SF2

This version of the Salamander Gran Piano sound bank in SF2 format has been
assembled by roberto (FreePats) for the FreePats project. It's a simplified
sound bank for synthesizers that require the SF2 format. Some features of the
original are not included, and in particular: amplifier velocity tracking
(amp_veltrack), noises of pedal, hammer and string resonance on key release.

The original Salamander Grand Piano was created by Alexander Holm. Published
under the terms of the Creative Commons Attribution 3.0 license:
http://creativecommons.org/licenses/by/3.0/

The original README is included below, please note that some information there
may not be applicable to this derivative version.

---------------------------------


Salamander Grand Piano V2
Yamaha C5


Technical info

Recorded @ 48khz24bit
16 Velocity layers Sampled in minor thirds from the lowest A.
Hammer noise releases chromatically sampled in onle one layer.
String resonance releases in minor thirds in three layers.
Two AKG c414 disposed in an AB position ~12cm above the strings


Some other general info:
This piano has been optimized and only properly tested for linuxsampler.
If you want to optimize the .sfz yourself, values of interest are:
-amp_veltrack (dynamics, %)
-ampeg_release (note release decay, seconds)
-The volume(in dB) on the pedal noise is located on the bottom of the .sfz file under //pedalAction
[!] I suggest you make a backup of the .sfz file before you start fiddling with it :)
In the time of writing, sfz for linuxsampler has not come out of cvs. So, it's still a bit of a pain to get this paino going.

Changelog:

V3+20161209
* Fixed missing '=' in lines 449 to 464 of SalamanderGrandPianoV3Retuned.sfz.

V3
* Removed rowchange after every opcode the .sfz file should be more human readable for people who'd like to customize things.
* Re-export A5v7-15 that had noticeable delay in beginning of file.
* Adjusted the velocity at wich notes are triggered.
* Increased ampeg_release to 1.000
* Decreased amp_veltrack to 75
* Retuned version by Markus Fiedler
* The old V2 .sfz should work so no need to delete it if you like it :)
* fixed a missing note

V2:
* Re-exported all notes with all lowcut filters removed and eased off some eq on some notes around C4
* Replaced all pedal noise samples, there are now two down and two up samples.
* Increased ampeg_veltrack on release harmonics from A0 to C2 * Increased
ampeg_release to 0.850 * Introduced a 44.1khz16bit and an ogg vorbis version


Licence:

CC-by
http://creativecommons.org/licenses/by/3.0/


Author: Alexander Holm
(contact address omitted)

