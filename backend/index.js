import { spawn } from "child_process";

const GAME_PATH =
	"D:\\games\\gameinstalled\\Dx11-samples\\x64\\Debug\\EmptyProject11.exe";

console.log("Launching Outlast 2...");

const game = spawn(GAME_PATH, [], {
	stdio: "inherit",
	detached: false,
});

// If the game closes
game.on("exit", (code) => {
	console.log("Game exited with code:", code);
});

// If launch fails
game.on("error", (err) => {
	console.error("Failed to start game:", err);
});
