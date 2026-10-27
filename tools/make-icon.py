#!/usr/bin/env python3
"""把 icon.png 转成多尺寸 icon.ico（Windows 任务栏/开始菜单小图标才清晰）。

用法：python tools/make-icon.py [源png] [输出ico]
依赖：ffmpeg 在 PATH 里（只用来做缩放和 BMP 导出）
"""
import os
import struct
import subprocess
import sys
import tempfile

SIZES = [16, 24, 32, 48, 64, 128, 256]


def bmp_bgra(png, size, tmpdir):
    """用 ffmpeg 缩放到 size×size 并导出 32 位 BMP，返回自底向上的 BGRA 原始字节"""
    out = os.path.join(tmpdir, "s%d.bmp" % size)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", png,
         "-vf", "scale=%d:%d:flags=lanczos" % (size, size),
         "-pix_fmt", "bgra", out],
        check=True,
    )
    d = open(out, "rb").read()
    off = struct.unpack("<I", d[10:14])[0]
    hdr_w, hdr_h = struct.unpack("<ii", d[18:26])
    bpp = struct.unpack("<H", d[28:30])[0]
    if (hdr_w, abs(hdr_h), bpp) != (size, size, 32):
        raise SystemExit("ffmpeg 输出异常: %dx%d %dbpp" % (hdr_w, hdr_h, bpp))
    xor = d[off:off + size * 4 * size]
    if len(xor) != size * 4 * size:
        raise SystemExit("BMP 像素数据长度不对")
    if hdr_h < 0:
        # 负高度 = 自顶向下存储，ICO 要求自底向上，按行翻过来
        rows = [xor[i * size * 4:(i + 1) * size * 4] for i in range(size)]
        xor = b"".join(reversed(rows))
    return xor


def ico_image(xor, size):
    """组一个 ICO 图条目：BITMAPINFOHEADER(高=2h) + BGRA + AND掩码"""
    and_row = ((size + 31) // 32) * 4
    and_mask = b"\x00" * (and_row * size)
    hdr = struct.pack(
        "<IiiHHIIiiII",
        40, size, size * 2, 1, 32, 0,
        len(xor) + len(and_mask), 0, 0, 0, 0,
    )
    return hdr + xor + and_mask


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "icon.png"
    dst = sys.argv[2] if len(sys.argv) > 2 else "icon.ico"
    if not os.path.exists(src):
        raise SystemExit("找不到 %s" % src)

    with tempfile.TemporaryDirectory() as td:
        blobs = [ico_image(bmp_bgra(src, s, td), s) for s in SIZES]

    out = bytearray(struct.pack("<HHH", 0, 1, len(SIZES)))
    offset = 6 + 16 * len(SIZES)
    for s, blob in zip(SIZES, blobs):
        out += struct.pack(
            "<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(blob), offset
        )
        offset += len(blob)
    for blob in blobs:
        out += blob

    open(dst, "wb").write(out)
    print("%s -> %s  (%d 尺寸, %d 字节)" % (src, dst, len(SIZES), len(out)))


if __name__ == "__main__":
    main()
