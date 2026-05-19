#!/usr/bin/env python3
"""Build a static signed APT repository from Load Rift .deb artifacts.

Output layout is suitable for GitHub Pages:
  pool/main/l/load-rift/*.deb
  dists/<suite>/Release
  dists/<suite>/InRelease
  dists/<suite>/Release.gpg
  dists/<suite>/main/binary-<arch>/Packages[.gz]

Signed repository generation is the default. Use --unsigned only for local checks.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import io
import pathlib
import shutil
import subprocess
import sys
import tarfile
from dataclasses import dataclass
from email.parser import Parser
from email.utils import format_datetime

DEFAULT_SUITE = "stable"
DEFAULT_COMPONENT = "main"
DEFAULT_PACKAGE = "load-rift"
DEFAULT_ORIGIN = "load-rift-stable-main"
DEFAULT_LABEL = "Load Rift"
DEFAULT_DESCRIPTION = "Load Rift APT repository"
DEFAULT_REPOSITORY_URL = "https://ddv1982.github.io/load-rift/apt/"
DEFAULT_SETUP_PACKAGE_NAME = "load-rift-repository-setup"
DEFAULT_SETUP_PACKAGE_VERSION = "1.0"
DEFAULT_SETUP_MAINTAINER = "Load Rift <noreply@loadrift.invalid>"
DEFAULT_SETUP_KEYRING_PATH = "/usr/share/keyrings/load-rift-archive-keyring.pgp"
DEFAULT_SETUP_SOURCES_PATH = "/etc/apt/sources.list.d/load-rift.sources"


@dataclass(frozen=True)
class DebPackage:
    pool_path: pathlib.PurePosixPath
    package: str
    architecture: str
    fields: dict[str, str]
    size: int
    md5: str
    sha1: str
    sha256: str


def read_ar_entries(deb_path: pathlib.Path) -> dict[str, bytes]:
    entries: dict[str, bytes] = {}
    with deb_path.open("rb") as handle:
        if handle.read(8) != b"!<arch>\n":
            raise ValueError(f"{deb_path} is not a Debian ar archive")
        while True:
            header = handle.read(60)
            if not header:
                break
            if len(header) != 60 or header[58:60] != b"`\n":
                raise ValueError(f"{deb_path} has an invalid ar member header")
            raw_name = header[:16].decode("utf-8", errors="replace").strip()
            size = int(header[48:58].decode("ascii").strip())
            data = handle.read(size)
            if len(data) != size:
                raise ValueError(f"{deb_path} has a truncated ar member")
            if size % 2 == 1:
                handle.read(1)
            entries[raw_name.rstrip("/")] = data
    return entries


def extract_tar_member(archive_name: str, data: bytes, member_name: str) -> bytes:
    mode = "r:*"
    if archive_name.endswith(".tar.zst"):
        zstd = shutil.which("zstd")
        if not zstd:
            raise ValueError(".deb uses zstd-compressed tar members; zstd command is required")
        completed = subprocess.run(
            [zstd, "-dc"], input=data, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        if completed.returncode != 0:
            raise ValueError(completed.stderr.decode("utf-8", errors="replace"))
        data = completed.stdout
        mode = "r:"

    with tarfile.open(fileobj=io.BytesIO(data), mode=mode) as tar:
        for member in tar.getmembers():
            normalized = member.name.removeprefix("./")
            if member.isfile() and normalized == member_name:
                extracted = tar.extractfile(member)
                if extracted is None:
                    break
                return extracted.read()
    raise ValueError(f"archive member {member_name!r} not found")


def parse_control(deb_path: pathlib.Path) -> dict[str, str]:
    entries = read_ar_entries(deb_path)
    control_name = next((name for name in entries if name.startswith("control.tar")), None)
    if not control_name:
        raise ValueError(f"{deb_path} does not contain control.tar.*")
    control_bytes = extract_tar_member(control_name, entries[control_name], "control")
    message = Parser().parsestr(control_bytes.decode("utf-8", errors="replace"))
    return {key: value for key, value in message.items()}


def format_deb822_field(key: str, value: str) -> str:
    value = value.rstrip("\n")
    if "\n" not in value:
        return f"{key}: {value}"
    first, *rest = value.splitlines()
    return "\n".join([f"{key}: {first}", *(f" {line}" for line in rest)])


def package_stanza(package: DebPackage) -> str:
    fields = dict(package.fields)
    fields["Filename"] = str(package.pool_path)
    fields["Size"] = str(package.size)
    fields["MD5sum"] = package.md5
    fields["SHA1"] = package.sha1
    fields["SHA256"] = package.sha256
    preferred = [
        "Package",
        "Version",
        "Architecture",
        "Maintainer",
        "Installed-Size",
        "Depends",
        "Section",
        "Priority",
        "Homepage",
        "Description",
        "Filename",
        "Size",
        "MD5sum",
        "SHA1",
        "SHA256",
    ]
    lines: list[str] = []
    emitted: set[str] = set()
    for key in preferred:
        if key in fields:
            lines.append(format_deb822_field(key, fields[key]))
            emitted.add(key)
    for key in sorted(fields):
        if key not in emitted:
            lines.append(format_deb822_field(key, fields[key]))
    return "\n".join(lines) + "\n"


def gzip_write(path: pathlib.Path, data: bytes) -> None:
    with path.open("wb") as handle:
        with gzip.GzipFile(filename="", mode="wb", fileobj=handle, mtime=0) as gz:
            gz.write(data)


def gzip_bytes(data: bytes) -> bytes:
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as gz:
        gz.write(data)
    return buffer.getvalue()


def tar_gz_bytes(files: dict[str, tuple[bytes, int]]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        for name, (data, mode) in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = "root"
            info.gname = "root"
            tar.addfile(info, io.BytesIO(data))
    return gzip_bytes(buffer.getvalue())


def ar_member(name: str, data: bytes) -> bytes:
    encoded_name = f"{name}/".encode("ascii")
    if len(encoded_name) > 16:
        raise ValueError(f"ar member name is too long: {name}")
    header = (
        encoded_name.ljust(16, b" ")
        + b"0".ljust(12, b" ")
        + b"0".ljust(6, b" ")
        + b"0".ljust(6, b" ")
        + b"100644".ljust(8, b" ")
        + str(len(data)).encode("ascii").ljust(10, b" ")
        + b"`\n"
    )
    padding = b"\n" if len(data) % 2 else b""
    return header + data + padding


def write_deb_archive(output: pathlib.Path, control_files: dict[str, tuple[bytes, int]], data_files: dict[str, tuple[bytes, int]]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(
        b"!<arch>\n"
        + ar_member("debian-binary", b"2.0\n")
        + ar_member("control.tar.gz", tar_gz_bytes(control_files))
        + ar_member("data.tar.gz", tar_gz_bytes(data_files))
    )


def file_hashes(path: pathlib.Path) -> tuple[str, str, str, int]:
    data = path.read_bytes()
    return (
        hashlib.md5(data, usedforsecurity=False).hexdigest(),
        hashlib.sha1(data).hexdigest(),
        hashlib.sha256(data).hexdigest(),
        len(data),
    )


def normalized_pool_filename(fields: dict[str, str]) -> str:
    package = fields.get("Package")
    version = fields.get("Version")
    arch = fields.get("Architecture")
    if not package or not version or not arch:
        raise ValueError("Debian control file must declare Package, Version, and Architecture")
    for key, value in {"Package": package, "Version": version, "Architecture": arch}.items():
        if any(char in value for char in ("/", "\x00", "\n", "\r")) or value in {".", ".."}:
            raise ValueError(f"unsafe {key} value for pool filename: {value!r}")
    return f"{package}_{version}_{arch}.deb"


def collect_package(source: pathlib.Path, pool_path: pathlib.PurePosixPath) -> DebPackage:
    fields = parse_control(source)
    package = fields.get("Package")
    architecture = fields.get("Architecture")
    if package != DEFAULT_PACKAGE:
        raise ValueError(f"unexpected package {package!r}; expected {DEFAULT_PACKAGE!r}")
    if not architecture:
        raise ValueError(f"{source} control file must declare Architecture")
    md5, sha1, sha256, size = file_hashes(source)
    return DebPackage(
        pool_path=pool_path,
        package=package,
        architecture=architecture,
        fields=fields,
        size=size,
        md5=md5,
        sha1=sha1,
        sha256=sha256,
    )


def release_file(repo_root: pathlib.Path, args: argparse.Namespace, architectures: list[str]) -> str:
    dists_root = repo_root / "dists" / args.suite
    targets = sorted(
        path
        for path in dists_root.rglob("*")
        if path.is_file() and path.name not in {"Release", "InRelease", "Release.gpg"}
    )
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    lines = [
        f"Origin: {args.origin}",
        f"Label: {args.label}",
        f"Suite: {args.suite}",
        f"Codename: {args.suite}",
        f"Date: {format_datetime(now, usegmt=True)}",
        f"Architectures: {' '.join(architectures)}",
        f"Components: {args.component}",
        f"Description: {args.description}",
    ]
    hash_rows = [(path.relative_to(dists_root).as_posix(), *file_hashes(path)) for path in targets]
    for section, index in [("MD5Sum", 1), ("SHA1", 2), ("SHA256", 3)]:
        lines.append(f"{section}:")
        for row in hash_rows:
            relative = row[0]
            digest = row[index]
            size = row[4]
            lines.append(f" {digest} {size:16d} {relative}")
    return "\n".join(lines) + "\n"


def gpg_base(args: argparse.Namespace) -> list[str]:
    gpg = shutil.which("gpg")
    if not gpg:
        raise RuntimeError("gpg is required for signed repository generation")
    base = [gpg, "--batch", "--yes", "--pinentry-mode", "loopback"]
    if args.gpg_homedir:
        base.extend(["--homedir", args.gpg_homedir])
    if args.gpg_passphrase_file:
        base.extend(["--passphrase-file", args.gpg_passphrase_file])
    if args.gpg_key:
        base.extend(["--local-user", args.gpg_key])
    return base


def sign_release(args: argparse.Namespace, release_path: pathlib.Path) -> None:
    base = gpg_base(args)
    subprocess.run([*base, "--clearsign", "--output", str(release_path.with_name("InRelease")), str(release_path)], check=True)
    subprocess.run(
        [*base, "--detach-sign", "--armor", "--output", str(release_path.with_name("Release.gpg")), str(release_path)],
        check=True,
    )


def export_public_key(args: argparse.Namespace) -> None:
    if not args.public_key_out:
        return
    output = pathlib.Path(args.public_key_out)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        subprocess.run([*gpg_base(args), "--export", args.gpg_key], check=True, stdout=handle)


def normalize_deb_data_path(path: str) -> str:
    if not path.startswith("/"):
        raise ValueError(f"Debian package install path must be absolute: {path!r}")
    parts = pathlib.PurePosixPath(path).parts
    data_parts = parts[1:]
    if len(data_parts) == 0 or any(part in {".", ".."} or any(ord(char) < 32 for char in part) for part in data_parts):
        raise ValueError(f"unsafe Debian package path: {path!r}")
    return "/".join(data_parts)


def setup_sources_text(args: argparse.Namespace, architectures: list[str], signed_by_path: str) -> str:
    lines = [
        "Types: deb",
        f"URIs: {args.repository_url}",
        f"Suites: {args.suite}",
        f"Components: {args.component}",
    ]
    if architectures:
        lines.append(f"Architectures: {' '.join(architectures)}")
    lines.append(f"Signed-By: {signed_by_path}")
    return "\n".join(lines) + "\n"


def build_setup_package(args: argparse.Namespace, architectures: list[str]) -> None:
    if not args.setup_package_out:
        return
    key_path = args.setup_public_key or args.public_key_out
    if not key_path:
        raise ValueError("--setup-package-out requires --setup-public-key or --public-key-out")
    keyring = pathlib.Path(key_path).read_bytes()
    if not keyring:
        raise ValueError(f"repository setup keyring source is empty: {key_path}")

    keyring_path = normalize_deb_data_path(args.setup_keyring_path)
    sources_path = normalize_deb_data_path(args.setup_sources_path)
    keyring_install_path = f"/{keyring_path}"
    sources_install_path = f"/{sources_path}"
    data_files = {
        f"./{keyring_path}": (keyring, 0o644),
        f"./{sources_path}": (setup_sources_text(args, architectures, keyring_install_path).encode("utf-8"), 0o644),
    }
    md5sums = "".join(
        f"{hashlib.md5(data, usedforsecurity=False).hexdigest()}  {name.removeprefix('./')}\n"
        for name, (data, _mode) in sorted(data_files.items())
    ).encode("utf-8")
    control = (
        f"Package: {args.setup_package_name}\n"
        f"Version: {args.setup_package_version}\n"
        "Architecture: all\n"
        "Section: admin\n"
        "Priority: optional\n"
        f"Maintainer: {args.setup_maintainer}\n"
        "Depends: apt, ca-certificates\n"
        "Description: Load Rift APT repository setup package\n"
        " Installs the Load Rift archive keyring and Deb822 source configuration.\n"
    ).encode("utf-8")
    write_deb_archive(
        pathlib.Path(args.setup_package_out),
        {
            "./control": (control, 0o644),
            "./conffiles": ((sources_install_path + "\n").encode("utf-8"), 0o644),
            "./md5sums": (md5sums, 0o644),
        },
        data_files,
    )


def build_repository(args: argparse.Namespace) -> None:
    repo_root = pathlib.Path(args.output).resolve()
    if args.clean and repo_root.exists():
        shutil.rmtree(repo_root)
    repo_root.mkdir(parents=True, exist_ok=True)

    packages: list[DebPackage] = []
    for deb in args.deb:
        source = pathlib.Path(deb).resolve()
        if not source.is_file():
            raise ValueError(f"missing .deb artifact: {source}")
        fields = parse_control(source)
        pool_rel = pathlib.PurePosixPath("pool/main/l/load-rift") / normalized_pool_filename(fields)
        destination = repo_root / pool_rel
        if destination.exists():
            raise ValueError(f"duplicate normalized package output path: {pool_rel}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        packages.append(collect_package(destination, pool_rel))

    by_arch: dict[str, list[DebPackage]] = {}
    for package in packages:
        by_arch.setdefault(package.architecture, []).append(package)

    for arch, arch_packages in sorted(by_arch.items()):
        binary_dir = repo_root / "dists" / args.suite / args.component / f"binary-{arch}"
        binary_dir.mkdir(parents=True, exist_ok=True)
        packages_bytes = "\n".join(package_stanza(package) for package in arch_packages).encode("utf-8")
        (binary_dir / "Packages").write_bytes(packages_bytes)
        gzip_write(binary_dir / "Packages.gz", packages_bytes)

    release_path = repo_root / "dists" / args.suite / "Release"
    architectures = sorted(by_arch)
    release_path.write_text(release_file(repo_root, args, architectures), encoding="utf-8")

    if args.unsigned:
        build_setup_package(args, architectures)
        return
    sign_release(args, release_path)
    export_public_key(args)
    build_setup_package(args, architectures)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a signed Load Rift APT repository.")
    parser.add_argument("deb", nargs="+", help="built .deb artifact(s) to publish")
    parser.add_argument("--output", required=True, help="repository output directory")
    parser.add_argument("--suite", default=DEFAULT_SUITE)
    parser.add_argument("--component", default=DEFAULT_COMPONENT)
    parser.add_argument("--origin", default=DEFAULT_ORIGIN)
    parser.add_argument("--label", default=DEFAULT_LABEL)
    parser.add_argument("--description", default=DEFAULT_DESCRIPTION)
    parser.add_argument("--repository-url", default=DEFAULT_REPOSITORY_URL)
    parser.add_argument("--gpg-key", help="GPG key id/fingerprint used for signing")
    parser.add_argument("--gpg-homedir", help="GPG home directory containing the signing key")
    parser.add_argument("--gpg-passphrase-file", help="optional passphrase file for loopback signing")
    parser.add_argument("--public-key-out", help="optional path for binary gpg --export output")
    parser.add_argument("--setup-package-out", help="optional load-rift-repository-setup_<version>_all.deb output")
    parser.add_argument("--setup-public-key", help="public keyring bytes for unsigned local setup package generation")
    parser.add_argument("--setup-package-name", default=DEFAULT_SETUP_PACKAGE_NAME)
    parser.add_argument("--setup-package-version", default=DEFAULT_SETUP_PACKAGE_VERSION)
    parser.add_argument("--setup-maintainer", default=DEFAULT_SETUP_MAINTAINER)
    parser.add_argument("--setup-keyring-path", default=DEFAULT_SETUP_KEYRING_PATH)
    parser.add_argument("--setup-sources-path", default=DEFAULT_SETUP_SOURCES_PATH)
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--unsigned", action="store_true", help="generate unsigned metadata for local tests only")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    if not args.unsigned and not args.gpg_key:
        parser.error("signed generation is the default; pass --gpg-key or --unsigned")
    if args.unsigned and args.public_key_out:
        parser.error("--public-key-out requires signed generation")
    if args.setup_package_out and args.unsigned and not args.setup_public_key:
        parser.error("--setup-package-out with --unsigned requires --setup-public-key")
    try:
        build_repository(args)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
