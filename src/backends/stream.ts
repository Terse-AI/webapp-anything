import { UserError } from "../util/errors.js";
import { posixBasename } from "../util/paths.js";
import type { Backend, BuildContext, BuildOutput } from "./types.js";

/** Pinned base image: LinuxServer's Selkies (WebSocket/WebRTC desktop streaming) on Debian. */
export const SELKIES_IMAGE = "ghcr.io/linuxserver/baseimage-selkies:debiantrixie";

/** Pinned Android 14 emulator with a noVNC web client (github.com/budtmo/docker-android). */
export const ANDROID_IMAGE = "budtmo/docker-android:emulator_14.0_v3.7.0-p1";

const JAVA_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const streamBackend: Backend = {
  id: "stream",
  title: "Container streaming (Selkies)",
  description:
    "Runs the program natively in a Docker container on your server and streams its window to the browser. Works for apps no browser runtime can handle.",
  runs: "64-bit Windows programs (via Wine), 64-bit/ARM Linux GUI apps, Java apps — on a server you run",
  assess(scan) {
    const exe = scan.executable;
    if (scan.kind === "windows-program" && exe?.format === "pe") {
      if (exe.arch !== "x86" && exe.arch !== "x86_64") return undefined;
      const native = exe.arch === "x86" && !exe.dotnet;
      return {
        backend: "stream",
        score: native ? 30 : 55,
        stability: "experimental",
        reasons: ["Runs under real Wine in a container and streams the window."],
        warnings: ["Needs a server with Docker; each viewer uses server CPU."],
      };
    }
    if (scan.kind === "windows-program" && exe?.format === "ne") {
      return {
        backend: "stream",
        score: 20,
        stability: "experimental",
        reasons: ["Wine in a container."],
        warnings: [],
      };
    }
    if (scan.kind === "linux-program" && exe?.format === "elf") {
      if (exe.arch !== "x86_64" && exe.arch !== "arm64" && exe.arch !== "x86") return undefined;
      return {
        backend: "stream",
        score: exe.arch === "x86" && !exe.gui ? 35 : 55,
        stability: "experimental",
        reasons: ["Runs natively in a Debian container and streams the window."],
        warnings: ["Needs a server with Docker; each viewer uses server CPU."],
      };
    }
    if (scan.kind === "android-app") {
      const abis = scan.android?.abis ?? [];
      const warnings = [
        "Needs a Linux server with Docker and KVM (/dev/kvm); on macOS or Windows run it in a Linux VM with nested virtualisation.",
      ];
      if (abis.length && !abis.some((a) => a === "x86_64" || a === "x86")) {
        warnings.push(
          `Native code is built only for ${abis.join(", ")}; the x86_64 emulator has to translate it, which some apps refuse.`,
        );
      }
      return {
        backend: "stream",
        score: 50,
        stability: "experimental",
        reasons: ["Runs in a real Android emulator in a container and streams the screen to the browser."],
        warnings,
      };
    }
    if (scan.kind === "java-app") {
      return {
        backend: "stream",
        score: 25,
        stability: "experimental",
        reasons: ["Runs on OpenJDK in a container."],
        warnings: [],
      };
    }
    return undefined;
  },
  async build(ctx: BuildContext): Promise<BuildOutput> {
    if (ctx.scan.kind === "android-app") return androidProject(ctx);
    const { scan, tree, out, options } = ctx;
    const exe = scan.executable;
    let install = "";
    let command: string;
    let platform: string | undefined;
    if (scan.kind === "java-app") {
      // Either the input is the jar itself, or a folder/archive that contains it.
      const inputIsJar = tree.container === "zip" && !scan.entry?.toLowerCase().endsWith(".jar");
      let jar = "app.jar";
      if (inputIsJar) await out.copyFile(ctx.inputPath, "app/app.jar");
      else {
        await out.copyTree(tree, "app");
        jar = scan.entry!;
      }
      install =
        "RUN apt-get update && apt-get install -y --no-install-recommends default-jre && rm -rf /var/lib/apt/lists/*";
      command = `java -jar ${sh(`/app/${jar}`)}`;
    } else if (scan.kind === "windows-program") {
      if (!scan.entry) throw new UserError("No program to start.");
      await out.copyTree(tree, "app");
      install = [
        "RUN dpkg --add-architecture i386 \\",
        "  && apt-get update \\",
        "  && apt-get install -y --no-install-recommends wine wine32:i386 wine64 \\",
        "  && rm -rf /var/lib/apt/lists/*",
        'ENV WINEDLLOVERRIDES="mscoree,mshtml="',
      ].join("\n");
      command = `wine ${sh(`/app/${scan.entry}`)}`;
      platform = "linux/amd64";
    } else if (scan.kind === "linux-program") {
      if (!scan.entry) throw new UserError("No program to start.");
      await out.copyTree(tree, "app");
      command = `${sh(`/app/${scan.entry}`)}`;
      if (exe?.format === "elf") {
        platform = exe.arch === "arm64" ? "linux/arm64" : "linux/amd64";
        if (exe.arch === "x86") {
          install =
            "RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends libc6:i386 && rm -rf /var/lib/apt/lists/*";
        }
      }
    } else {
      throw new UserError(`The stream backend cannot run ${scan.kind}.`);
    }
    if (options.args.length) command += ` ${options.args.map(sh).join(" ")}`;
    const entryName = scan.entry ? posixBasename(scan.entry) : "app";

    await out.write(
      "Dockerfile",
      `# Generated by webapp-anything: streams "${options.title}" to the browser with Selkies.
FROM ${SELKIES_IMAGE}
ENV TITLE=${JSON.stringify(options.title)}
${install}
COPY app/ /app/
COPY root/ /
RUN chmod -R a+rX /app${scan.kind === "linux-program" && scan.entry ? ` && chmod +x ${sh(`/app/${scan.entry}`)}` : ""}
`,
    );
    const autostart = `#!/bin/bash\ncd /app\nexec ${command}\n`;
    await out.write("root/defaults/autostart", autostart);
    await out.write("root/defaults/autostart_wayland", autostart);
    await out.write(
      "compose.yaml",
      `services:
  app:
    build: .
    image: waa-${options.slug}
${platform ? `    platform: ${platform}\n` : ""}    shm_size: "1gb"
    ports:
      - "3001:3001"
    environment:
      - TITLE=${options.title.replace(/\n/g, " ")}
      # Strongly recommended when exposed to the internet:
      # - CUSTOM_USER=viewer
      # - PASSWORD=change-me
    restart: unless-stopped
`,
    );
    await out.write(
      "README.md",
      `# ${options.title}

This folder was generated by [webapp-anything](https://github.com/Terse-AI/webapp-anything) from \`${scan.input.name}\` (${entryName}).
It runs the program natively inside a container and streams it to the browser with
[Selkies](https://github.com/selkies-project/selkies) (base image \`${SELKIES_IMAGE}\`).

\`\`\`bash
docker compose up --build
\`\`\`

Then open **https://localhost:3001** (the container uses a self-signed certificate; put it behind your
reverse proxy with a real certificate for public use, and set \`CUSTOM_USER\`/\`PASSWORD\`).

Every open browser tab shares the same session and uses CPU on the server.
`,
    );
    await out.write(".dockerignore", "waa.json\nREADME.md\n");
    return {
      type: "container",
      runtimes: [],
      requirements: { crossOriginIsolation: false, network: [] },
      notices: [`Streams the program from a container built on ${SELKIES_IMAGE}.`],
      warnings: [
        "This output is a Docker project, not a static site: run `docker compose up --build` in it.",
      ],
    };
  },
};

/** An APK: a docker-android emulator plus a one-shot service that installs and opens the app. */
async function androidProject(ctx: BuildContext): Promise<BuildOutput> {
  const { scan, out, options } = ctx;
  if (ctx.tree.container !== "zip") throw new UserError("Android apps must be given as an .apk file.");
  await out.copyFile(ctx.inputPath, "app/app.apk");
  const info = scan.android;
  const pkg = info?.package && JAVA_NAME.test(info.package) ? info.package : undefined;
  const launcher = pkg && info?.launcher && JAVA_NAME.test(info.launcher) ? info.launcher : undefined;
  const warnings = ["This output is a Docker project, not a static site: run `docker compose up` in it."];
  let launch = "";
  if (launcher) launch = `"$ADB" -s "$DEVICE" shell am start -n ${sh(`${pkg}/${launcher}`)}`;
  else if (pkg)
    launch = `"$ADB" -s "$DEVICE" shell monkey -p ${sh(pkg)} -c android.intent.category.LAUNCHER 1`;
  else warnings.push("The APK's package name could not be read; open the app from the emulator's launcher.");

  await out.write(
    "app/install.sh",
    `#!/bin/bash
# Generated by webapp-anything: installs ${pkg ?? "the app"} once the emulator has booted, then opens it.
set -euo pipefail
ADB="$(command -v adb || echo /opt/android/platform-tools/adb)"
DEVICE=android:5555
until "$ADB" connect "$DEVICE" | grep -q connected; do sleep 5; done
"$ADB" -s "$DEVICE" wait-for-device
until [ "$("$ADB" -s "$DEVICE" shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 5; done
"$ADB" -s "$DEVICE" install -r -g /waa/app.apk
${launch}
`,
  );
  await out.write(
    "compose.yaml",
    `# Generated by webapp-anything: streams "${options.title.replace(/\n/g, " ")}" from an Android emulator.
services:
  android:
    image: ${ANDROID_IMAGE}
    platform: linux/amd64
    devices:
      - /dev/kvm
    ports:
      - "6080:6080"
    environment:
      - EMULATOR_DEVICE=Samsung Galaxy S10
      - WEB_VNC=true
      - USER_BEHAVIOR_ANALYTICS=false
      # Strongly recommended when exposed to the internet:
      # - VNC_PASSWORD=change-me
    volumes:
      # The emulator's data partition: installed apps and saved games survive restarts.
      - android-data:/home/androidusr
    restart: unless-stopped
  install:
    image: ${ANDROID_IMAGE}
    platform: linux/amd64
    depends_on:
      - android
    entrypoint: ["/bin/bash", "/waa/install.sh"]
    volumes:
      - ./app:/waa:ro
    restart: on-failure
volumes:
  android-data:
`,
  );
  await out.write(
    "README.md",
    `# ${options.title}

This folder was generated by [webapp-anything](https://github.com/Terse-AI/webapp-anything) from \`${scan.input.name}\`${
      pkg ? ` (\`${pkg}\`${info?.versionName ? ` ${info.versionName}` : ""})` : ""
    }.
It runs the app in a real Android 14 emulator ([docker-android](https://github.com/budtmo/docker-android),
image \`${ANDROID_IMAGE}\`) and streams the screen to the browser with noVNC.

Requirements: a Linux host with Docker and hardware virtualisation (\`/dev/kvm\`; check with \`kvm-ok\`).
macOS and Windows need a Linux VM with nested virtualisation.

\`\`\`bash
docker compose up -d
\`\`\`

The first boot takes a few minutes. The \`install\` service waits for Android, installs \`app/app.apk\` and opens it.
Then open **http://localhost:6080/?autoconnect=true&resize=scale**.

For public use put port 6080 behind your reverse proxy with TLS and set \`VNC_PASSWORD\` in \`compose.yaml\`.
Every viewer shares one emulator, which uses about 2 CPU cores and 4 GB of RAM on the server.
`,
  );
  await out.write(".dockerignore", "waa.json\nREADME.md\n");
  return {
    type: "container",
    runtimes: [],
    requirements: { crossOriginIsolation: false, network: [] },
    notices: [
      `Streams the app from an Android emulator built on ${ANDROID_IMAGE}.`,
      "Android system images are distributed under the Android SDK license.",
    ],
    warnings,
  };
}
