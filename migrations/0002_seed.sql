-- Seed default reply templates (Vietnamese, decor tone — adjust freely)
INSERT INTO reply_templates (intent, template, weight) VALUES
  ('PRAISE', 'Cảm ơn {name} nhiều ạ ❤️ Shop sẽ ra thêm nhiều mẫu mới nha!', 3),
  ('PRAISE', 'Dạ cảm ơn bạn {name} đã ủng hộ shop ạ 🌷', 2),
  ('PRAISE', '{name} ơi, cảm ơn bạn nhiều nhé ✨', 2),
  ('QUESTION', 'Dạ {name} ơi, shop inbox riêng cho bạn nhé!', 3),
  ('QUESTION', 'Bạn {name} đợi shop tí, mình rep inbox luôn ạ 💌', 2),
  ('OTHER', 'Cảm ơn bạn {name} đã quan tâm ạ 🌷', 1);

-- Seed default funnel triggers (decor business)
INSERT INTO funnel_triggers (keyword, reply_public, dm_template) VALUES
  ('giá', 'Đã inbox bạn bảng giá rồi nhé 💌',
   'Chào {name}! Cảm ơn bạn đã quan tâm. Shop gửi bảng giá + ảnh chi tiết các mẫu decor đang hot:\n\n🌷 Set decor mini từ 99k\n🪴 Set tổng combo từ 299k\n✨ Freeship đơn từ 250k\n\nBạn thích mẫu nào để shop tư vấn cụ thể nha?'),
  ('inbox', 'Shop đã inbox bạn rồi ạ ✨',
   'Chào {name}! Shop đây ạ. Bạn quan tâm mẫu nào trong post mình tư vấn chi tiết nhé!'),
  ('catalog', 'Đã gửi catalog cho bạn 💌',
   'Chào {name}! Shop gửi bạn catalog mẫu hot tháng này nha. Có ảnh thật + giá đầy đủ.');
