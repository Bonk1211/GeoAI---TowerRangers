This dataset contains 30,925 labelled and cleaned records collected from a dense 2 km² urban area surrounding Sunway University, Selangor, Malaysia. Using the GNetTrack Pro mobile application and Samsung S21 Ultra devices, the data spans three anonymized commercial mobile network operators and includes both 4G and 5G technologies. The dataset captures radio signal quality metrics (RSRP, RSRQ, SNR, etc.), geospatial information, mobility patterns (walking vs. driving), and application-specific traffic scenarios (HTTP, FTP, 1080p Video Streaming).

A total of 132 physical cell sites were validated via OpenCellID and field inspections. The dataset is released in CSV format and includes Python scripts for data preprocessing and basic visualization. This makes it a valuable resource for machine learning tasks like signal metric regression, handover optimization, and QoE modeling in heterogeneous and simulation of high-density urban networks.

Key features:

Real-world 5G/4G measurements

Multi-operator and multi-mobility modes

Traffic-aware profiling

Empirical validation of base station locations

Ready for ML/DL use cases

For more information look out for our article about the dataset on data in brief journal.


Step 1: Data Collection
Tool Used: GNetTrack Pro (Android app by Gyokov Solutions)

Device: Samsung S21 Ultra

Location: Outdoor areas within 2 km radius of Sunway University

Operators: 3 major Malaysian operators (anonymized as A, B, C)

Mobility Modes: Walking (pedestrian/canopy) and Driving (shuttle/BRT)

Traffic Contexts: HTTP browsing, FTP uploads/downloads, 1080p video streaming

Upload: Logs were auto-uploaded to a cloud database

Step 2: Data Preprocessing
Download raw logs from the cloud.

Merge and clean data using python script:

Remove duplicates and null values

Validate and cap signal metrics using 3GPP TS 36.214 standards

Categorize mobility (Walking, Driving) using speed thresholds

Map and anonymize operator names

Engineer features:

Mobility from speed

Node_Latitude / Node_Longitude using signal centroid mapping

ElapsedTime for session-based modeling

SessionID for sequence tracking

Resulting output: raw_dataset.csv

Step 3: Data Analysis & Visualization
Use Colab notebook to:

Analyze network technology distribution

Visualize signal strength distributions

Plot traffic types and altitude profiles

Estimate node locations using centroid-based techniques

Step 4: Ready for ML/DL
Cleaned data supports regression and classification tasks:

Handover management

Signal quality forecasting

Multi-operator performance analysis

Context-aware optimization for 5G networks