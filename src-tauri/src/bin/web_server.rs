#[tokio::main]
async fn main() {
    if let Err(error) = infinite_canvas_lib::web::run().await {
        eprintln!("SuCanvasServer: {error}");
        std::process::exit(1);
    }
}
