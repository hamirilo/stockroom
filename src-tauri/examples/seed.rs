//! Fills a library with generated test images.
//!   cargo run --release --example seed -- <path/to/X.library> [count]
use image::{Rgb, RgbImage};
use stockroom_lib::{db, import, library::Library};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("usage: seed <library> [count]"));
    let count: u32 = args.next().map(|s| s.parse().unwrap()).unwrap_or(200);

    let src = std::env::temp_dir().join(format!("stockroom-seed-{}", std::process::id()));
    std::fs::create_dir_all(&src).unwrap();
    let t = Instant::now();
    let files: Vec<PathBuf> = (0..count)
        .map(|i| {
            // Varied aspect ratios and colours, unique per index.
            let (w, h) = [(800, 600), (600, 800), (1200, 500), (700, 700)][(i % 4) as usize];
            let hue = (i * 47 % 360) as f32;
            let img = RgbImage::from_fn(w, h, |x, y| {
                let f = (x + y) as f32 / (w + h) as f32;
                let c = |o: f32| ((((hue + o) / 60.0).sin() * 0.5 + 0.5) * 255.0 * (0.4 + 0.6 * f)) as u8;
                Rgb([c(0.0), c(120.0), (i % 256) as u8])
            });
            let p = src.join(format!("sample-{i:05}.jpg"));
            img.save(&p).unwrap();
            p
        })
        .collect();
    println!("generated {count} images in {:?}", t.elapsed());

    let lib = Mutex::new(Some(Library::create(&root).unwrap()));
    let t = Instant::now();
    let sum = import::run(
        &lib,
        files.into_iter().map(import::Source::file).collect(),
        None,
        |_, _| {},
    )
    .unwrap();
    println!("imported {} (dup {}, failed {}) in {:?}", sum.imported, sum.duplicates, sum.failed.len(), t.elapsed());
    std::fs::remove_dir_all(&src).ok();

    let mut guard = lib.lock().unwrap();
    let l = guard.as_mut().unwrap();
    let all = db::query_items(
        &l.conn,
        &db::ItemQuery { desc: true, ..Default::default() },
    )
    .unwrap();
    // A little structure so the sidebar has something to show.
    let animals = db::create_folder(&l.conn, "動物", None).unwrap();
    let cats = db::create_folder(&l.conn, "ねこ", Some(&animals)).unwrap();
    db::create_folder(&l.conn, "風景", None).unwrap();
    let ids: Vec<String> = all.iter().map(|i| i.id.clone()).collect();
    db::move_to_folder(&l.conn, &ids[..ids.len() / 4], &animals).unwrap();
    db::move_to_folder(&l.conn, &ids[..ids.len() / 8], &cats).unwrap();
    db::add_tags(&mut l.conn, &ids[..ids.len() / 3], &["参考".into()]).unwrap();
    db::add_tags(&mut l.conn, &ids[ids.len() / 6..ids.len() / 2], &["ブルー".into(), "背景".into()]).unwrap();

    let t = Instant::now();
    let n = db::query_items(
        &l.conn,
        &db::ItemQuery { search: "sample".into(), sort: db::SortKey::Name, ..Default::default() },
    )
    .unwrap()
    .len();
    println!("query of {n} items with search+sort took {:?}", t.elapsed());
}
