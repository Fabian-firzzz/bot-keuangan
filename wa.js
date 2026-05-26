import "dotenv/config";
import {
  default as makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  BufferJSON,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import http from "http";

const prisma = new PrismaClient();
const logger = pino({ level: "silent" });

async function usePrismaAuthState(sessionId) {
  const writeData = async (data, id) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await prisma.session.upsert({
      where: { id: `${sessionId}_${id}` },
      update: { value },
      create: { id: `${sessionId}_${id}`, value },
    });
  };

  const readData = async (id) => {
    try {
      const dbRow = await prisma.session.findUnique({
        where: { id: `${sessionId}_${id}` },
      });
      if (dbRow) {
        return JSON.parse(dbRow.value, BufferJSON.reviver);
      }
      return null;
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await prisma.session.delete({
        where: { id: `${sessionId}_${id}` },
      });
    } catch (error) {}
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData(creds, "creds");
    },
  };
}

// Flag agar hanya ada 1 proses reconnect yang berjalan
let reconnectScheduled = false;

async function startWA() {
  reconnectScheduled = false;

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await usePrismaAuthState("wa_session");

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Scan QR code ini di WhatsApp kamu:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`Koneksi terputus (kode: ${statusCode})`);

      // Hapus semua listener socket ini agar tidak ada konflik
      sock.ev.removeAllListeners();

      if (!loggedOut && !reconnectScheduled) {
        reconnectScheduled = true;
        console.log("Reconnecting dalam 5 detik...");
        setTimeout(() => startWA(), 5000);
      } else if (loggedOut) {
        console.log("Logged out. Hapus folder wa_session lalu jalankan ulang.");
        process.exit(1);
      }
    }

    if (connection === "open") {
      reconnectScheduled = false;
      console.log("✅ WhatsApp bot terhubung!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;

      const msg = messages[0];
      if (!msg.message) return;

      const from = msg.key.remoteJid;
      const teks =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      const myJid = sock.user?.id ? sock.user.id.split(":")[0] + "@s.whatsapp.net" : "";
      const myLid = sock.user?.lid ? sock.user.lid.split(":")[0] + "@lid" : "";

      // Abaikan pesan dari diri sendiri, KECUALI jika itu chat dengan diri sendiri (self-chat)
      if (msg.key.fromMe) {
        if (from !== myJid && from !== myLid) return;
      }

      if (!teks.startsWith("/")) return;

      console.log(`🤖 Perintah diterima: "${teks}" dari ${from}`);

    const parts = teks.trim().split(" ");
    const perintah = parts[0].toLowerCase();
    const args = parts.slice(1);

    const balas = (text) => sock.sendMessage(from, { text });

    // ── /start ──────────────────────────────────────────
    if (perintah === "/start") {
      await balas("Halo! Gw bot keuangan lu 💰\nKetik /help buat liat perintah.");
    }

    // ── /help ───────────────────────────────────────────
    else if (perintah === "/help") {
      await balas(
        "📋 Perintah yang tersedia:\n\n" +
        "/catat pengeluaran [jumlah] [keterangan]\n" +
        "/catat pemasukan [jumlah] [keterangan]\n" +
        "/saldo — Cek saldo\n" +
        "/laporan — Lihat semua transaksi\n" +
        "/hapus [id] — Hapus transaksi berdasarkan ID"
      );
    }

    // ── /catat ──────────────────────────────────────────
    else if (perintah === "/catat") {
      if (args.length < 3) {
        await balas(
          "❌ Format salah!\n\n" +
          "Contoh:\n" +
          "/catat pengeluaran 50000 makan siang\n" +
          "/catat pemasukan 5000000 gajian"
        );
        return;
      }

      const tipe = args[0].toLowerCase();
      const jumlah = parseInt(args[1]);
      const keterangan = args.slice(2).join(" ");

      if (tipe !== "pengeluaran" && tipe !== "pemasukan") {
        await balas("❌ Tipe harus 'pengeluaran' atau 'pemasukan'");
        return;
      }

      if (isNaN(jumlah) || jumlah <= 0) {
        await balas("❌ Jumlah harus angka yang valid!");
        return;
      }

      await prisma.transaksi.create({ data: { tipe, jumlah, keterangan } });

      const emoji = tipe === "pemasukan" ? "💚" : "🔴";
      await balas(
        `${emoji} Transaksi dicatat!\n\n` +
        `Tipe: ${tipe}\n` +
        `Jumlah: Rp ${jumlah.toLocaleString("id-ID")}\n` +
        `Keterangan: ${keterangan}\n` +
        `Tanggal: ${new Date().toLocaleDateString("id-ID")}`
      );
    }

    // ── /saldo ──────────────────────────────────────────
    else if (perintah === "/saldo") {
      const transaksi = await prisma.transaksi.findMany();

      const totalPemasukan = transaksi
        .filter((t) => t.tipe === "pemasukan")
        .reduce((sum, t) => sum + t.jumlah, 0);

      const totalPengeluaran = transaksi
        .filter((t) => t.tipe === "pengeluaran")
        .reduce((sum, t) => sum + t.jumlah, 0);

      const saldo = totalPemasukan - totalPengeluaran;

      await balas(
        `💰 Ringkasan Keuangan\n\n` +
        `💚 Total Pemasukan: Rp ${totalPemasukan.toLocaleString("id-ID")}\n` +
        `🔴 Total Pengeluaran: Rp ${totalPengeluaran.toLocaleString("id-ID")}\n` +
        `─────────────────\n` +
        `💵 Saldo: Rp ${saldo.toLocaleString("id-ID")}`
      );
    }

    // ── /laporan ─────────────────────────────────────────
    else if (perintah === "/laporan") {
      const transaksi = await prisma.transaksi.findMany({
        orderBy: { tanggal: "desc" },
        take: 10,
      });

      if (transaksi.length === 0) {
        await balas("📭 Belum ada transaksi yang dicatat.");
        return;
      }

      let teks = "📊 10 Transaksi Terakhir\n\n";
      transaksi.forEach((t, i) => {
        const emoji = t.tipe === "pemasukan" ? "💚" : "🔴";
        const tgl = new Date(t.tanggal).toLocaleDateString("id-ID");
        teks += `${i + 1}. [ID:${t.id}] ${emoji} Rp ${t.jumlah.toLocaleString("id-ID")} — ${t.keterangan} (${tgl})\n`;
      });

      teks += "\n🗑️ Hapus transaksi: /hapus [id]";
      await balas(teks);
    }

    // ── /hapus ───────────────────────────────────────────
    else if (perintah === "/hapus") {
      const id = parseInt(args[0]);

      if (isNaN(id) || id <= 0) {
        await balas("❌ Format salah!\nContoh: /hapus 12");
        return;
      }

      const transaksi = await prisma.transaksi.findUnique({ where: { id } });

      if (!transaksi) {
        await balas(`❌ Transaksi dengan ID ${id} tidak ditemukan.`);
        return;
      }

      await prisma.transaksi.delete({ where: { id } });

      const emoji = transaksi.tipe === "pemasukan" ? "💚" : "🔴";
      await balas(
        `🗑️ Transaksi dihapus!\n\n` +
        `${emoji} Rp ${transaksi.jumlah.toLocaleString("id-ID")} — ${transaksi.keterangan}`
      );
    }
  } catch (error) {
    console.error("❌ Terjadi error di messages.upsert:", error);
  }
  });
}

startWA();

// Web server mini untuk Render Health Check & Uptime ping
const PORT = process.env.PORT || 3005;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!");
}).listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});
