import Head from "next/head";
import Image from "next/image";
import { useState } from "react";
import {
  getEncoding,
  parseSrt,
  Node,
  nodesToSrtText,
  checkIsSrtFile,
  nodesToTransNodes,
  convertToSrt,
} from "@/lib/srt";
import Subtitles from "@/components/Subtitles";
import { toast, Toaster } from "react-hot-toast";
import styles from "@/styles/Srt.module.css";
import { useTranslation } from "next-i18next";
import { suportedLangZh, commonLangZh, langBiMap } from "@/lib/lang";
import { CacheKey, ENABLE_SHOP } from "@/utils/constants";

const MAX_FILE_SIZE = 512 * 1024; // 512KB
const PAGE_SIZE = 10;
const MAX_RETRY = 5;

/**
 * 下载文件
 * @param filename 文件名
 * @param text 文本内容
 */
function download(filename: string, text: string) {
  var element = document.createElement("a");
  element.setAttribute(
    "href",
    "data:text/plain;charset=utf-8," + encodeURIComponent(text)
  );
  element.setAttribute("download", filename);

  element.style.display = "none";
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}

function curPageNodes(nodes: Node[], curPage: number) {
  let res = nodes.slice(curPage * PAGE_SIZE, (curPage + 1) * PAGE_SIZE);
  if (res.findIndex((n) => n) === -1) {
    res = [];
  }
  return res;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 翻译所有
 * @param nodes 待翻译节点列表
 * @param lang 目标语言
 * @param apiKey apiKey
 * @param notifyResult 翻译完 结果通知回调
 * @param useGoogle 是否启用谷歌翻译
 * @param promptTemplate 提示语模板
 * @param customHost 自定义Host
 * @returns
 */
async function traslate_all(
  nodes: Node[],
  lang: string,
  apiKey?: string,
  notifyResult?: any,
  useGoogle?: boolean,
  promptTemplate?: string,
  customHost?: string
) {
  const batches: Node[][] = [];
  for (let i = 0; i < nodes.length; i += PAGE_SIZE) {
    batches.push(nodes.slice(i, i + PAGE_SIZE));
  }
  // for now, just use sequential execution
  const results: Node[] = [];
  let batch_num = 0;
  for (const batch of batches) {
    let success = false;
    for (let i = 0; i < MAX_RETRY && !success; i++) {
      try {
        const r = await translate_one_batch(
          batch,
          lang,
          apiKey,
          useGoogle,
          promptTemplate,
          customHost
        );
        results.push(...r);
        success = true;
        if (notifyResult) {
          notifyResult(batch_num, r);
        }
        console.log(`Translated ${results.length} of ${nodes.length}`);
      } catch (e) {
        console.error(e);
        await sleep(3000); // may exceed rate limit, sleep for a while
      }
    }
    batch_num++;
    if (!success) {
      console.error(`translate_all failed for ${batch}`);
      throw new Error(`translate file ${batch} failed`);
    }
  }
  return results;
}

/**
 * 按照节点列表翻译
 * @param nodes 待翻译节点列表
 * @param lang 目标语言
 * @param apiKey apiKey
 * @param useGoogle 是否启用谷歌翻译
 * @param promptTemplate 提示语模板
 * @param customHost 自定义Host
 * @returns
 */
async function translate_one_batch(
  nodes: Node[],
  lang: string,
  apiKey?: string,
  useGoogle?: boolean,
  promptTemplate?: string,
  customHost?: string
) {
  const sentences = nodes.map((node) => node.content);
  // if last sentence ends with ",", remove it
  const lastSentence = sentences[sentences.length - 1];
  if (lastSentence.endsWith(",") || lastSentence.endsWith("，")) {
    sentences[sentences.length - 1] = lastSentence.substring(
      0,
      lastSentence.length - 1
    );
  }

  let options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      targetLang: lang,
      sentences: sentences,
      apiKey: apiKey,
      promptTemplate: promptTemplate,
      baseHost: customHost,
    }),
  };

  console.time("request /api/translate");
  const url = useGoogle ? "/api/googleTran" : "/api/translate";
  const res = await fetch(url, options);
  console.timeEnd("request /api/translate");

  if (res.redirected) {
    if (ENABLE_SHOP) {
      window.location.href = res.url;
      throw new Error(" redirected");
    } else {
      throw new Error(" rate limited. Please enter you OpenAI key");
    }
  }

  const jres = await res.json();
  if (jres.errorMessage) {
    throw new Error(jres.errorMessage);
  }
  return nodesToTransNodes(nodes, jres);
}

/**
 * 清空文件
 */
function clearFileInput() {
  const finput = document.getElementById("file") as HTMLInputElement;
  if (finput) {
    finput.value = "";
  }
}

/**
 * 转换文件时的状态
 */
type TranslateFileStatus = {
  isTranslating: boolean;
  transCount: number;
};

export default function Srt() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [transNodes, setTransNodes] = useState<Node[]>([]); // make transNode the same structure as nodes
  const [curPage, setCurPage] = useState(0);
  const [filename, setFilename] = useState("");
  const [loading, setLoading] = useState(false);
  const [transFileStatus, setTransFileStatus] = useState<TranslateFileStatus>({
    isTranslating: false,
    transCount: 0,
  });
  const [showAllLang, setShowAllLang] = useState(false);
  const { t } = useTranslation("common");
  const langs = showAllLang ? suportedLangZh : commonLangZh;
  const isEnglish = t("English") === "English";

  const getUseGoogle = () => {
    const res = localStorage.getItem("translate-engine");
    if (res) {
      return JSON.parse(res) === "google";
    }
    return false;
  };

  const getUserKey = () => {
    const res = localStorage.getItem(CacheKey.UserApikeyWithOpenAi);
    if (res) return JSON.parse(res) as string;
  };

  const getUserCustomHost = () => {
    const res = localStorage.getItem(CacheKey.UserBaseHostWithOpenAi);
    if (res) return JSON.parse(res) as string;
  };

  //提示语
  const getUserPrompt = () => {
    const res = localStorage.getItem("user-prompt-template");
    if (res) return res;
  };

  //多语言
  const getLang = () => {
    return (document.getElementById("langSelect") as HTMLSelectElement).value;
  };

  /**
   * 添加字幕并渲染
   * @param text 文本内容
   * @param fname 文件名
   * @returns
   */
  const onNewSubtitleText = (text: string, fname: string) => {
    if (!checkIsSrtFile(text)) {
      const converted = convertToSrt(text);
      if (converted) {
        text = converted;
      } else {
        toast.error("Cannot convert to a valid SRT file");
        clearFileInput();
        return;
      }
    }
    const nodes = parseSrt(text);
    setNodes(nodes);
    setTransNodes([]);
    setCurPage(0);
    setFilename(fname);
  };

  //默认列表
  //   useEffect(() => {
  //     (async () => {
  //       const resp = await fetch("/1900s.srt");
  //       const text = await resp.text();
  //       onNewSubtitleText(text, "1900 (Movie) example");
  //     })();
  //   }, []);

  /**
   *  选择字幕文件
   * @returns
   */
  const onChooseFile = async (e: any) => {
    const input = e.target;
    const f: File = input.files[0];
    if (!f) return;
    if (f.size > MAX_FILE_SIZE) {
      toast.error(t("Max file size 512KB"));
      clearFileInput();
      return;
    }
    const encoding = await getEncoding(f);
    if (!encoding) {
      toast.error(t("Cannot open as text file"));
      clearFileInput();
      return;
    }
    const data = await f.arrayBuffer();
    let text = new TextDecoder(encoding!).decode(data);
    onNewSubtitleText(text, f.name);
  };

  const toPage = (delta: number) => {
    const newPage = curPage + delta;
    if (newPage < 0 || newPage >= nodes.length / PAGE_SIZE) return;
    setCurPage(newPage);
  };

  const on_trans_result = (batch_num: number, tnodes: Node[]) => {
    setTransFileStatus((old) => {
      return { ...old, transCount: batch_num + 1 };
    });
    setTransNodes((nodes) => {
      const nodesCopy = [...nodes];
      for (let i = 0; i < PAGE_SIZE; i++) {
        nodesCopy[batch_num * PAGE_SIZE + i] = tnodes[i];
      }
      return nodesCopy;
    });
  };

  /**
   * 翻译整个文件
   */
  const translateFile = async () => {
    setTransFileStatus({ isTranslating: true, transCount: 0 });
    try {
      const newnodes = await traslate_all(
        nodes,
        getLang(),
        getUserKey(),
        on_trans_result,
        getUseGoogle(),
        getUserPrompt(),
        getUserCustomHost()
      );
      //download("output.srt", nodesToSrtText(newnodes));
      toast.success(t("translate file successfully"));
    } catch (e) {
      toast.error(t("translate file failed ") + String(e));
    }
    setTransFileStatus((old) => {
      return { ...old, isTranslating: false };
    });
  };

  /**
   * 翻译当前页面
   */
  const translate = async () => {
    setLoading(true);
    try {
      const newnodes = await translate_one_batch(
        curPageNodes(nodes, curPage),
        getLang(),
        getUserKey(),
        getUseGoogle(),
        getUserPrompt(),
        getUserCustomHost()
      );
      setTransNodes((nodes) => {
        const nodesCopy = [...nodes];
        for (let i = 0; i < PAGE_SIZE; i++) {
          nodesCopy[curPage * PAGE_SIZE + i] = newnodes[i];
        }
        return nodesCopy;
      });
    } catch (e) {
      console.error("translate failed", e);
      toast.error(t("translate failed") + String(e));
    }
    setLoading(false);
  };

  /**
   * 下载源文件
   */
  const download_original = () => {
    if (nodes.length == 0) {
      toast.error("暂无可下载内容");
      return;
    }

    download("original.srt", nodesToSrtText(nodes));
  };

  /**
   * 下载翻译字幕
   */
  const download_translated = () => {
    //const nodes = transNodes.filter((n) => n);
    if (transNodes.length == 0) {
      toast.error("暂无可下载内容");
      return;
    }

    download("translated.srt", nodesToSrtText(transNodes));
  };

  /**
   * 下载双语字幕
   */
  const download_translated_retain_original = () => {
    if (transNodes.length == 0) {
      toast.error("暂无可下载内容");
      return;
    }

    const tempTransNodes = transNodes;

    tempTransNodes.forEach((it) => {
      const currentOriginal = nodes.filter((item) => item.pos == it.pos);
      if (currentOriginal.length == 1) {
        //源文件在上 翻译在下
        it.content = `${currentOriginal[0].content}\n${it.content}`;
      }
    });

    download("translated_双语.srt", nodesToSrtText(tempTransNodes));
  };

  const get_page_count = () => Math.ceil(nodes.length / PAGE_SIZE);

  return (
    <>
      <Head>
        <title>{t("AI-Subtilte")}</title>
      </Head>
      <main style={{ minHeight: "90vh" }}>
        <Toaster
          position="top-center"
          reverseOrder={false}
          toastOptions={{ duration: 4000 }}
        />
        <div className={styles.welcomeMessage}>{t("Welcome")}</div>

        <div
          style={{
            display: "flex",
            margin: "0 auto",
            paddingTop: "30px",
            justifyContent: "center",
            maxWidth: "900px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex" }}>
              <a
                href="#!"
                className={styles.file}
                style={{ marginLeft: "50px" }}
              >
                {t("select-local-sub")}
                <input
                  onChange={onChooseFile}
                  type="file"
                  accept=".srt,.ass,.txt"
                  id="file"
                />
              </a>
            </div>
            <div style={{ display: "flex", alignItems: "center" }}>
              <button
                className={styles.navButton}
                onClick={() => toPage(-1)}
                type="button"
              >
                {t("prev")}
              </button>
              <p
                style={{
                  display: "inline-block",
                  textAlign: "center",
                  width: "65px",
                }}
              >
                {curPage + 1} / {Math.ceil(nodes.length / PAGE_SIZE)}
              </p>
              <button
                className={styles.navButton}
                onClick={() => toPage(1)}
                type="button"
              >
                {t("next")}
              </button>

              <label style={{ marginRight: "10px", marginLeft: "120px" }}>
                {t("targetLang")}
              </label>
              <select className={styles.selectLang} id="langSelect">
                {langs.map((lang) => (
                  <option key={lang} value={lang}>
                    {isEnglish ? langBiMap.get(lang) : lang}
                  </option>
                ))}
              </select>
              <input
                type="checkbox"
                title={t("Show All languages")!}
                style={{ marginLeft: "5px" }}
                checked={showAllLang}
                onChange={(e) => setShowAllLang(e.target.checked)}
              ></input>
              {!loading ? (
                <button
                  onClick={translate}
                  type="button"
                  title={t("API-Slow-Warn")!}
                  className={styles.genButton}
                  style={{ marginLeft: "5px", height: "30px", width: "80px" }}
                >
                  {t("Translate-This")}
                </button>
              ) : (
                <button
                  disabled
                  type="button"
                  className={styles.genButton}
                  style={{ marginLeft: "20px", height: "30px", width: "80px" }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Image
                      src="/loading.svg"
                      alt="Loading..."
                      width={20}
                      height={20}
                    />
                  </div>
                </button>
              )}
            </div>
            <div style={{ color: "gray" }}>
              {filename ? filename : t("No subtitle selected")}
            </div>
            <Subtitles
              nodes={curPageNodes(nodes, curPage)}
              transNodes={curPageNodes(transNodes, curPage)}
            />
            <div
              style={{
                width: "100%",
                display: "flex",
                justifyContent: "flex-end",
                marginTop: "20px",
                marginRight: "50px",
              }}
            >
              {!transFileStatus.isTranslating ? (
                <button
                  onClick={translateFile}
                  className={styles.genButton}
                  style={{
                    height: "30px",
                    marginRight: "20px",
                    width: "120px",
                  }}
                >
                  {t("Translate-File")}
                </button>
              ) : (
                <button
                  onClick={translateFile}
                  disabled
                  className={styles.genButton}
                  style={{
                    height: "30px",
                    marginRight: "20px",
                    width: "120px",
                  }}
                >
                  <Image
                    src="/loading.svg"
                    alt="Loading..."
                    width={20}
                    height={20}
                  />
                  {t("Progress")}
                  {transFileStatus.transCount}/{get_page_count()}
                </button>
              )}
              <button
                onClick={download_original}
                className={styles.genButton}
                style={{ height: "30px", marginRight: "20px" }}
              >
                {t("Download-Original")}
              </button>
              <button
                onClick={download_translated}
                className={styles.genButton}
                style={{ height: "30px", marginRight: "20px" }}
              >
                {t("Download-Translated")}
              </button>

              <button
                onClick={download_translated_retain_original}
                className={styles.genButton}
                style={{ height: "30px" }}
              >
                下载双语字幕
              </button>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
