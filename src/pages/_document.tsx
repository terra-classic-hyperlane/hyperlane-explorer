import { Head, Html, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />

        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="mask-icon" href="/safari-pinned-tab.svg" color="#9A0DFF" />
        <link rel="shortcut icon" href="/favicon.svg" />
        <meta name="msapplication-TileColor" content="#1a0a28" />
        <meta name="theme-color" content="#1a0a28" />

        <meta name="application-name" content="Hyperlane Explorer" />
        <meta
          name="keywords"
          content="Hyperlane Explorer Scan Interchain Permissionless Interoperability Network Blockchain"
        />

        <meta name="HandheldFriendly" content="true" />
        <meta name="apple-mobile-web-app-title" content="Hyperlane Explorer" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </Head>
      <body className="font-sans text-black" style={{ backgroundColor: '#f8f8ff' }}>
        {/* Suppress browser extension errors (e.g. TronLink) before Next.js dev overlay captures them */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  function isExt(s){return typeof s==='string'&&(s.indexOf('chrome-extension://')>=0||s.indexOf('moz-extension://')>=0);}
  var _oe=window.onerror;
  window.onerror=function(msg,src,line,col,err){
    if(isExt(src)||isExt(err&&err.stack)){return true;}
    return typeof _oe==='function'?_oe.apply(this,arguments):false;
  };
  window.addEventListener('error',function(e){
    if(isExt(e.filename)||isExt(e.error&&e.error.stack)){e.stopImmediatePropagation();e.preventDefault();}
  },true);
  window.addEventListener('unhandledrejection',function(e){
    var s=String((e.reason&&e.reason.stack)||e.reason||'');
    if(isExt(s)){e.stopImmediatePropagation();e.preventDefault();}
  },true);
})();`,
          }}
        />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
