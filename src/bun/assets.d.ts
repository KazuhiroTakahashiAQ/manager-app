// テキストとして同梱するファイル（import … with { type: "text" }）
declare module "*.swift" {
	const text: string;
	export default text;
}
