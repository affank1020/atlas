import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MediaLibrary } from "./Portfolio";
import { callTool } from "./api";

vi.mock("./api", () => ({ API_BASE: "", callTool: vi.fn() }));
vi.mock("./atlasApi", () => ({ useApplicationRead: vi.fn() }));

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

function UploadHarness({reload = async () => {}}: {reload?: () => Promise<void>}) {
 const [busy,setBusy] = useState("");
 return <MediaLibrary media={[]} busy={busy} setBusy={setBusy} setError={vi.fn()} setNotice={vi.fn()} reload={reload}/>;
}

function choose(files: File[]) {
 fireEvent.click(screen.getByRole("button",{name:/upload media/i}));
 fireEvent.change(screen.getByLabelText("Choose files"),{target:{files}});
}

test("uploads several images with individual metadata and refreshes media once", async () => {
 const reload=vi.fn(async()=>{});
 vi.mocked(callTool).mockResolvedValue({} as never);
 render(<UploadHarness reload={reload}/>);
 choose([new File(["first"],"first.png",{type:"image/png"}),new File(["second"],"second.webp",{type:"image/webp"})]);
 expect(screen.getByText("2 files selected")).toBeInTheDocument();
 fireEvent.change(screen.getByRole("textbox",{name:"Alt text for first.png"}),{target:{value:"First screenshot"}});
 fireEvent.change(screen.getByRole("textbox",{name:"Alt text for second.webp"}),{target:{value:"Second screenshot"}});
 fireEvent.click(screen.getByRole("button",{name:"Upload 2 files"}));
 await waitFor(()=>expect(reload).toHaveBeenCalledTimes(1));
 expect(callTool).toHaveBeenCalledTimes(2);
 expect(callTool).toHaveBeenNthCalledWith(1,"upload_portfolio_media",expect.objectContaining({fileName:"first.png",mimeType:"image/png",altText:"First screenshot"}));
 expect(callTool).toHaveBeenNthCalledWith(2,"upload_portfolio_media",expect.objectContaining({fileName:"second.webp",mimeType:"image/webp",altText:"Second screenshot"}));
 expect(screen.queryByText("2 files selected")).not.toBeInTheDocument();
});

test("retry submits only failed files, not those already uploaded", async () => {
 let attempts=0;
 vi.mocked(callTool).mockImplementation(async (_name,args)=>{
  if(args?.fileName==="second.png"&&attempts++===0) throw new Error("Storage unavailable");
  return {} as never;
 });
 render(<UploadHarness/>);
 choose([new File(["first"],"first.png",{type:"image/png"}),new File(["second"],"second.png",{type:"image/png"})]);
 fireEvent.click(screen.getByRole("button",{name:"Upload 2 files"}));
 await screen.findByText("Storage unavailable");
 expect(screen.getByRole("button",{name:"Retry 1 file"})).toBeEnabled();
 fireEvent.click(screen.getByRole("button",{name:"Retry 1 file"}));
 await waitFor(()=>expect(screen.queryByText("2 files selected")).not.toBeInTheDocument());
 expect(vi.mocked(callTool).mock.calls.map(call=>call[1]?.fileName)).toEqual(["first.png","second.png","second.png"]);
});

test("rejects unsupported selected files without sending them", async () => {
 vi.mocked(callTool).mockResolvedValue({} as never);
 render(<UploadHarness/>);
 choose([new File(["text"],"notes.txt",{type:"text/plain"}),new File(["image"],"image.png",{type:"image/png"})]);
 expect(screen.getByText("Unsupported file type.")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"Upload 1 file"}));
 await waitFor(()=>expect(screen.getByText("Uploaded")).toBeInTheDocument());
 expect(callTool).toHaveBeenCalledTimes(1);
 expect(vi.mocked(callTool).mock.calls[0]?.[1]?.fileName).toBe("image.png");
});
