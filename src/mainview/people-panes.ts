// 関係者タブの左（組織ツリー）・右（詳細）パネルの開閉の状態遷移。DOM に触らない純関数。
// 詳細はノード・行を選んだときだけ出す。人が閉じたら、選択中でも次に選び直すまで閉じたまま。

export type Panes = {
	/** 左の組織ツリーを開いているか（保存する） */
	orgsOpen: boolean;
	/** ノード・行を選んでいるか */
	hasSel: boolean;
	/** 人が詳細を閉じたか（選び直すか選択を外すと戻る） */
	detailClosed: boolean;
};

export const initialPanes = (orgsOpen = true): Panes => ({ orgsOpen, hasSel: false, detailClosed: false });

export const detailVisible = (p: Panes): boolean => p.hasSel && !p.detailClosed;

export const select = (p: Panes): Panes => ({ ...p, hasSel: true, detailClosed: false });
export const deselect = (p: Panes): Panes => ({ ...p, hasSel: false, detailClosed: false });
export const closeDetail = (p: Panes): Panes => ({ ...p, detailClosed: true });
export const toggleOrgs = (p: Panes): Panes => ({ ...p, orgsOpen: !p.orgsOpen });

/** 保存値 → orgsOpen。空・壊れた値は開く（既定） */
export const parseOrgsOpen = (v: string | null | undefined): boolean => v !== "0";
