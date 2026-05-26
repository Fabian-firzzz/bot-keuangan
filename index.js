import "dotenv/config";
import { Bot } from "grammy";
import { PrismaClient } from "@prisma/client";

const bot = new Bot(process.env.BOT_TOKEN);
const prisma = new PrismaClient();
console.log("Token:", process.env.BOT_TOKEN);

bot.command("start", (ctx) => {
  ctx.reply("Halo! Gw bot keuangan lu 💰\nKetik /help buat liat perintah.");
});

bot.command("help", (ctx) => {
  ctx.reply(
    "📋 Perintah yang tersedia:\n\n" +
    "/catat pengeluaran [jumlah] [keterangan]\n" +
    "/catat pemasukan [jumlah] [keterangan]\n" +
    "/saldo — Cek saldo\n" +
    "/laporan — Lihat semua transaksi\n" +
    "/hapus [id] — Hapus transaksi berdasarkan ID"
  );
});

bot.command("catat", async (ctx) => {
  const args = ctx.match.trim().split(" ");

  if (args.length < 3) {
    return ctx.reply(
      "❌ Format salah!\n\n" +
      "Contoh:\n" +
      "/catat pengeluaran 50000 makan siang\n" +
      "/catat pemasukan 5000000 gajian"
    );
  }

  const tipe = args[0].toLowerCase();
  const jumlah = parseInt(args[1]);
  const keterangan = args.slice(2).join(" ");

  if (tipe !== "pengeluaran" && tipe !== "pemasukan") {
    return ctx.reply("❌ Tipe harus 'pengeluaran' atau 'pemasukan'");
  }

  if (isNaN(jumlah) || jumlah <= 0) {
    return ctx.reply("❌ Jumlah harus angka yang valid!");
  }

  // Simpan ke database
  await prisma.transaksi.create({
    data: { tipe, jumlah, keterangan },
  });

  const emoji = tipe === "pemasukan" ? "💚" : "🔴";
  ctx.reply(
    `${emoji} Transaksi dicatat!\n\n` +
    `Tipe: ${tipe}\n` +
    `Jumlah: Rp ${jumlah.toLocaleString("id-ID")}\n` +
    `Keterangan: ${keterangan}\n` +
    `Tanggal: ${new Date().toLocaleDateString("id-ID")}`
  );
});

bot.command("saldo", async (ctx) => {
  const transaksi = await prisma.transaksi.findMany();

  const totalPemasukan = transaksi
    .filter((t) => t.tipe === "pemasukan")
    .reduce((sum, t) => sum + t.jumlah, 0);

  const totalPengeluaran = transaksi
    .filter((t) => t.tipe === "pengeluaran")
    .reduce((sum, t) => sum + t.jumlah, 0);

  const saldo = totalPemasukan - totalPengeluaran;

  ctx.reply(
    `💰 Ringkasan Keuangan\n\n` +
    `💚 Total Pemasukan: Rp ${totalPemasukan.toLocaleString("id-ID")}\n` +
    `🔴 Total Pengeluaran: Rp ${totalPengeluaran.toLocaleString("id-ID")}\n` +
    `─────────────────\n` +
    `💵 Saldo: Rp ${saldo.toLocaleString("id-ID")}`
  );
});

bot.command("laporan", async (ctx) => {
  const transaksi = await prisma.transaksi.findMany({
    orderBy: { tanggal: "desc" },
    take: 10, // tampil 10 transaksi terakhir
  });

  if (transaksi.length === 0) {
    return ctx.reply("📭 Belum ada transaksi yang dicatat.");
  }

  let teks = "📊 10 Transaksi Terakhir\n\n";
  transaksi.forEach((t, i) => {
    const emoji = t.tipe === "pemasukan" ? "💚" : "🔴";
    const tgl = new Date(t.tanggal).toLocaleDateString("id-ID");
    teks += `${i + 1}. [ID:${t.id}] ${emoji} Rp ${t.jumlah.toLocaleString("id-ID")} — ${t.keterangan} (${tgl})\n`;
  });

  teks += "\n🗑️ Hapus transaksi: /hapus [id]";
  ctx.reply(teks);
});

bot.command("hapus", async (ctx) => {
  const id = parseInt(ctx.match.trim());

  if (isNaN(id) || id <= 0) {
    return ctx.reply("❌ Format salah!\nContoh: /hapus 12");
  }

  const transaksi = await prisma.transaksi.findUnique({ where: { id } });

  if (!transaksi) {
    return ctx.reply(`❌ Transaksi dengan ID ${id} tidak ditemukan.`);
  }

  await prisma.transaksi.delete({ where: { id } });

  const emoji = transaksi.tipe === "pemasukan" ? "💚" : "🔴";
  ctx.reply(
    `🗑️ Transaksi dihapus!\n\n` +
    `${emoji} Rp ${transaksi.jumlah.toLocaleString("id-ID")} — ${transaksi.keterangan}`
  );
});

bot.start();
console.log("Bot jalan!");